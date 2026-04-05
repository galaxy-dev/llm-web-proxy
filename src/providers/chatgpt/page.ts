// ChatGPT 页面交互层：封装输入、发送、等待回复、提取回复文本等 DOM 操作
//
// 通过候选选择器列表适配 ChatGPT 前端频繁变动的 DOM 结构，
// resolveSelector() 按优先级探测并缓存命中的选择器，失效时自动重试。
// 长文本（>2000字符）通过剪贴板粘贴发送，全局互斥锁防止并发覆盖。
// 回复检测分两阶段：停止按钮消失 → 文本稳定性确认，兼顾快速回复和流式输出。
// 超时场景携带 partialResponse 返回，避免长等待后完全丢失结果。

import type { Page, Locator } from "playwright";
import type { Config } from "../../types.js";
import { ProxyError, ErrorCode } from "../../errors.js";
import type { ProviderPage } from "../registry.js";

/**
 * 剪贴板全局互斥锁。
 * 防止多个会话并发粘贴长文本时互相覆盖剪贴板内容。
 */
let clipboardLocked = false;
const clipboardQueue: Array<() => void> = [];

async function acquireClipboard(): Promise<void> {
  if (!clipboardLocked) {
    clipboardLocked = true;
    return;
  }
  return new Promise<void>((resolve) => {
    clipboardQueue.push(resolve);
  });
}

function releaseClipboard(): void {
  const next = clipboardQueue.shift();
  if (next) {
    next();
  } else {
    clipboardLocked = false;
  }
}

/**
 * 交互元素选择器候选列表。
 * 通过 resolveSelector() 按顺序探测可见性并缓存结果。
 */
const SELECTOR_CANDIDATES = {
  messageInput: [
    "#prompt-textarea",
    '[data-testid="composer-input"]',
    'textarea[placeholder*="Message"]',
    "div.ProseMirror[contenteditable]",
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    "#composer-submit-button",
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
  ],
};

/**
 * 助手消息选择器 — 观察目标，在新对话中可能尚不存在。
 * 每次查询当前 DOM，不做缓存。
 */
const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  ".agent-turn",
];

/** 封装单个 ChatGPT 页面标签页的交互操作 */
export class ChatGPTPage implements ProviderPage {
  private page: Page;
  private config: Config;
  /** 已解析的选择器缓存，避免重复探测 */
  private resolved: Record<string, string> = {};

  constructor(page: Page, config: Config) {
    this.page = page;
    this.config = config;
  }

  /**
   * 从候选列表中解析出当前可见的交互元素选择器并缓存。
   * 所有候选都不可见时抛出 PAGE_STRUCTURE_CHANGED。
   */
  private async resolveSelector(
    key: keyof typeof SELECTOR_CANDIDATES,
    timeout = 3000
  ): Promise<string> {
    // 先检查缓存的选择器是否仍然可见
    if (this.resolved[key]) {
      const visible = await this.page
        .locator(this.resolved[key])
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return this.resolved[key];
      delete this.resolved[key];
    }

    const candidates = SELECTOR_CANDIDATES[key];

    // 快速检查：遍历所有候选
    for (const sel of candidates) {
      const visible = await this.page
        .locator(sel)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        this.resolved[key] = sel;
        return sel;
      }
    }

    // 等待任一候选变为可见
    const combined = candidates.join(", ");
    await this.page.waitForSelector(combined, {
      state: "visible",
      timeout,
    });

    for (const sel of candidates) {
      const visible = await this.page
        .locator(sel)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        this.resolved[key] = sel;
        return sel;
      }
    }

    throw new ProxyError(
      ErrorCode.PAGE_STRUCTURE_CHANGED,
      `Unable to resolve visible selector for "${key}"`
    );
  }

  /** 获取所有助手消息的组合定位器（每次查询 DOM，不缓存） */
  private assistantMessages() {
    return this.page.locator(ASSISTANT_MESSAGE_SELECTORS.join(", "));
  }

  private stopButtonCombinedSelector(): string {
    return SELECTOR_CANDIDATES.stopButton.join(", ");
  }

  /** 读取输入框文本，兼容 textarea 和 contenteditable 两种实现 */
  private async readComposerText(input: Locator): Promise<string> {
    const tagName = await input
      .evaluate((el) => el.tagName.toLowerCase())
      .catch(() => "");
    if (tagName === "textarea") {
      return await input.inputValue().catch(() => "");
    }
    return await input.innerText().catch(() => "");
  }

  /** 打开一个新的临时对话页面 */
  async navigateToNewChat(): Promise<void> {
    // temporary-chat=true 避免在账号中保存聊天记录
    await this.page.goto(`${this.config.providerUrl}/?temporary-chat=true`, {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeouts.navigation,
    });

    await this.resolveSelector("messageInput", this.config.timeouts.navigation);

    // 关闭可能出现的弹窗/遮罩
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(500);
  }

  /** 发送消息并等待 ChatGPT 回复，返回回复文本 */
  async sendMessage(text: string): Promise<string> {
    // 记录发送前的助手消息数量，用于检测新回复出现
    const beforeCount = await this.assistantMessages().count();

    // 聚焦输入框（ProseMirror 需要先建立焦点和选区）
    const inputSel = await this.resolveSelector("messageInput");
    const input = this.page.locator(inputSel);
    await input.click();

    if (text.length > 2000) {
      // 长文本通过剪贴板粘贴，需全局加锁防止并发冲突
      await acquireClipboard();
      try {
        await this.page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"]);
        await this.page.evaluate(async (value) => {
          await navigator.clipboard.writeText(value);
        }, text);
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        await this.page.keyboard.press(`${modifier}+KeyV`);

        // 粘贴后清空剪贴板
        await this.page
          .evaluate(async () => navigator.clipboard.writeText(""))
          .catch(() => {});
      } finally {
        releaseClipboard();
      }

      // 长文本粘贴后 ChatGPT 可能将其转为文件附件
      const attached = await this.waitForAttachment(10_000);

      if (attached) {
        // 附件创建后输入框被清空，需填入提示语才能发送
        await input.click();
        await input.pressSequentially(this.config.attachmentPrompt, {
          delay: 5,
        });
      } else {
        // 未生成附件 — 验证文本是否留在了输入框中
        const composerText = await this.readComposerText(input);
        if (composerText.trim().length === 0) {
          throw new ProxyError(
            ErrorCode.PAGE_STRUCTURE_CHANGED,
            "Long text paste failed: no attachment or composer content detected"
          );
        }
      }
    } else {
      // 短文本：逐字符输入，规避 contenteditable 的 fill() 兼容问题
      await input.pressSequentially(text, { delay: 5 });
    }

    // 等待发送按钮可用并点击
    await this.waitUntilSendReadyAndSubmit();

    // 等待新的助手消息出现
    try {
      await this.assistantMessages()
        .nth(beforeCount)
        .waitFor({
          state: "visible",
          timeout: this.config.timeouts.response,
        });
    } catch {
      throw new ProxyError(
        ErrorCode.PAGE_STRUCTURE_CHANGED,
        "No new assistant message appeared — ChatGPT page structure may have changed"
      );
    }

    // 等待流式响应结束（超时则抛出 RESPONSE_TIMEOUT 并携带部分回复）
    await this.waitForResponseComplete();

    return this.getLastAssistantMessage();
  }

  /** 等待 ChatGPT 流式响应完成：先等停止按钮消失，再通过文本稳定性二次确认 */
  private async waitForResponseComplete(): Promise<void> {
    const { response: responseTimeout, stability: stabilityMs } =
      this.config.timeouts;
    const deadline = Date.now() + responseTimeout;
    const checkInterval = 500;
    const stopSel = this.stopButtonCombinedSelector();

    // 阶段一：等待流式指示器（停止按钮）出现再消失
    const alreadyVisible = await this.page
      .locator(stopSel)
      .first()
      .isVisible()
      .catch(() => false);

    if (!alreadyVisible) {
      // 尚未出现 — 短暂等待（快速回复可能跳过此阶段）
      try {
        await this.page.waitForSelector(stopSel, {
          state: "visible",
          timeout: 3000,
        });
      } catch {
        // 从未出现 — 回复可能已完成
      }
    }

    // 等待停止按钮消失（流式输出结束）
    let stopButtonCleared = false;
    try {
      const remaining = Math.max(0, deadline - Date.now());
      await this.page.waitForSelector(stopSel, {
        state: "hidden",
        timeout: remaining,
      });
      stopButtonCleared = true;
    } catch {
      // 超时 — 继续进入稳定性检查
    }

    // 阶段二：文本稳定性检查 — 确认回复文本不再变化
    // 停止按钮正常消失时只需一次快速确认；超时时使用完整稳定窗口
    const effectiveStability = stopButtonCleared ? checkInterval : stabilityMs;
    let lastText = "";
    let stableTime = 0;

    while (Date.now() < deadline) {
      const currentText = await this.getLastAssistantMessage();

      if (currentText === lastText && currentText.length > 0) {
        stableTime += checkInterval;
        if (stableTime >= effectiveStability) return;
      } else {
        stableTime = 0;
        lastText = currentText;
      }

      await this.page.waitForTimeout(checkInterval);
    }

    // 超时 — 必须返回 RESPONSE_TIMEOUT，不能返回 200
    const partialText = await this.getLastAssistantMessage();
    throw new ProxyError(
      ErrorCode.RESPONSE_TIMEOUT,
      "Timed out waiting for ChatGPT response",
      partialText || undefined
    );
  }

  /** 提取最后一条助手消息的文本 */
  private async getLastAssistantMessage(): Promise<string> {
    const messages = this.assistantMessages();
    const count = await messages.count();
    if (count === 0) return "";

    const last = messages.nth(count - 1);
    return (await last.innerText()).trim();
  }

  /** 等待长文本粘贴后的附件元素出现，返回是否成功 */
  private async waitForAttachment(timeout: number): Promise<boolean> {
    const sel = 'button[aria-label^="Remove file"]';
    try {
      await this.page.waitForSelector(sel, { state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** 等待发送按钮可点击并提交，超时后回退为 Enter 键发送 */
  private async waitUntilSendReadyAndSubmit(): Promise<void> {
    const deadline = Date.now() + this.config.timeouts.navigation;

    while (Date.now() < deadline) {
      for (const sel of SELECTOR_CANDIDATES.sendButton) {
        const btn = this.page.locator(sel).first();
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;

        const disabled = await btn
          .evaluate((el) => (el as HTMLButtonElement).disabled)
          .catch(() => true);
        if (!disabled) {
          await btn.click();
          return;
        }
      }
      await this.page.waitForTimeout(200);
    }

    // 兜底：找不到可用按钮时用 Enter 键发送
    const input = this.page.locator(
      await this.resolveSelector("messageInput")
    );
    await input.click();
    await this.page.keyboard.press("Enter");
  }

  getPageUrl(): string {
    return this.page.url();
  }

  /** 关闭页面标签 */
  async close(): Promise<void> {
    await this.page.close().catch(() => {});
  }
}
