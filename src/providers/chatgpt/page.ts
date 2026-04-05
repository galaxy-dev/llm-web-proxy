// ChatGPT page interaction layer: encapsulates input, send, wait for reply, and extract reply text DOM operations
//
// Adapts to ChatGPT's frequently changing DOM structure via candidate selector lists.
// resolveSelector() probes candidates by priority and caches the match; retries on invalidation.
// Long text (>2000 chars) is sent via clipboard paste with a global mutex to prevent concurrent overwrites.
// Reply detection has two phases: stop button disappears -> text stability check,
// balancing fast replies and streaming output.
// Timeout scenarios carry partialResponse to avoid total loss after long waits.

import type { Page, Locator } from "playwright";
import type { Config } from "../../types.js";
import { ProxyError, ErrorCode } from "../../errors.js";
import type { ProviderPage, ProviderPageOptions } from "../registry.js";

/**
 * Global clipboard mutex.
 * Prevents concurrent long-text pastes from overwriting each other's clipboard content.
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
 * Candidate selector lists for interactive elements.
 * resolveSelector() probes visibility in order and caches the result.
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
 * Assistant message selectors — observation targets that may not exist in a new conversation.
 * Queries the current DOM each time; not cached.
 */
const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  ".agent-turn",
];

/** Encapsulates interaction with a single ChatGPT page tab */
export class ChatGPTPage implements ProviderPage {
  private page: Page;
  private config: Config;
  private providerUrl: string;
  private ephemeral: boolean;
  /** Resolved selector cache to avoid repeated probing */
  private resolved: Record<string, string> = {};

  constructor(page: Page, config: Config, options: ProviderPageOptions) {
    this.page = page;
    this.config = config;
    this.providerUrl = options.providerUrl;
    this.ephemeral = options.ephemeral;
  }

  /**
   * Resolve a visible interactive element selector from the candidate list and cache it.
   * Throws PAGE_STRUCTURE_CHANGED when none of the candidates are visible.
   */
  private async resolveSelector(
    key: keyof typeof SELECTOR_CANDIDATES,
    timeout = 3000
  ): Promise<string> {
    // Check if the cached selector is still visible
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

    // Quick check: iterate all candidates
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

    // Wait for any candidate to become visible
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

  /** Get a combined locator for all assistant messages (queries DOM each time, not cached) */
  private assistantMessages() {
    return this.page.locator(ASSISTANT_MESSAGE_SELECTORS.join(", "));
  }

  private stopButtonCombinedSelector(): string {
    return SELECTOR_CANDIDATES.stopButton.join(", ");
  }

  /** Read composer text, compatible with both textarea and contenteditable implementations */
  private async readComposerText(input: Locator): Promise<string> {
    const tagName = await input
      .evaluate((el) => el.tagName.toLowerCase())
      .catch(() => "");
    if (tagName === "textarea") {
      return await input.inputValue().catch(() => "");
    }
    return await input.innerText().catch(() => "");
  }

  /** Navigate to a new conversation page */
  async navigateToNewChat(): Promise<void> {
    const query = this.ephemeral ? "?temporary-chat=true" : "";
    await this.page.goto(`${this.providerUrl}/${query}`, {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeouts.navigation,
    });

    await this.resolveSelector("messageInput", this.config.timeouts.navigation);

    // Dismiss any popups/overlays that may appear
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(500);
  }

  /** Send a message and wait for the ChatGPT reply; returns the reply text */
  async sendMessage(text: string): Promise<string> {
    // Record assistant message count before sending, to detect when a new reply appears
    const beforeCount = await this.assistantMessages().count();

    // Focus the input (ProseMirror needs focus and selection established first)
    const inputSel = await this.resolveSelector("messageInput");
    const input = this.page.locator(inputSel);
    await input.click();

    if (text.length > 2000 || text.includes("\n")) {
      // Clipboard paste for long text or text with newlines (Enter triggers send in chat UIs)
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

        // Clear clipboard after paste
        await this.page
          .evaluate(async () => navigator.clipboard.writeText(""))
          .catch(() => {});
      } finally {
        releaseClipboard();
      }

      // After pasting long text, ChatGPT may convert it to a file attachment
      const attached = await this.waitForAttachment(10_000);

      if (attached) {
        // Composer is cleared after attachment creation; fill in the prompt to enable sending
        await input.click();
        await input.pressSequentially(this.config.attachmentPrompt, {
          delay: 5,
        });
      } else {
        // No attachment generated — verify text remains in the composer
        const composerText = await this.readComposerText(input);
        if (composerText.trim().length === 0) {
          throw new ProxyError(
            ErrorCode.PAGE_STRUCTURE_CHANGED,
            "Long text paste failed: no attachment or composer content detected"
          );
        }
      }
    } else {
      // Short text: type character-by-character to work around contenteditable fill() issues
      await input.pressSequentially(text, { delay: 5 });
    }

    // Wait for the send button to become available and click it
    await this.waitUntilSendReadyAndSubmit();

    // Wait for a new assistant message to appear
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

    // Wait for streaming response to finish (throws RESPONSE_TIMEOUT with partial reply on timeout)
    await this.waitForResponseComplete();

    return this.getLastAssistantMessage();
  }

  /** Wait for ChatGPT streaming response to complete: stop button disappears, then text stability check */
  private async waitForResponseComplete(): Promise<void> {
    const { response: responseTimeout, stability: stabilityMs } =
      this.config.timeouts;
    const deadline = Date.now() + responseTimeout;
    const checkInterval = 500;
    const stopSel = this.stopButtonCombinedSelector();

    // Phase 1: wait for the streaming indicator (stop button) to appear then disappear
    const alreadyVisible = await this.page
      .locator(stopSel)
      .first()
      .isVisible()
      .catch(() => false);

    if (!alreadyVisible) {
      // Not yet visible — wait briefly (fast replies may skip this phase)
      try {
        await this.page.waitForSelector(stopSel, {
          state: "visible",
          timeout: 3000,
        });
      } catch {
        // Never appeared — reply may already be complete
      }
    }

    // Wait for the stop button to disappear (streaming output finished)
    let stopButtonCleared = false;
    try {
      const remaining = Math.max(0, deadline - Date.now());
      await this.page.waitForSelector(stopSel, {
        state: "hidden",
        timeout: remaining,
      });
      stopButtonCleared = true;
    } catch {
      // Timed out — continue to stability check
    }

    // Phase 2: text stability check — confirm reply text has stopped changing
    // After normal stop button clearance, only a quick confirmation is needed;
    // on timeout, use the full stability window
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

    // Timed out — must return RESPONSE_TIMEOUT, not 200
    const partialText = await this.getLastAssistantMessage();
    throw new ProxyError(
      ErrorCode.RESPONSE_TIMEOUT,
      "Timed out waiting for ChatGPT response",
      partialText || undefined
    );
  }

  /** Extract the text of the last assistant message */
  private async getLastAssistantMessage(): Promise<string> {
    const messages = this.assistantMessages();
    const count = await messages.count();
    if (count === 0) return "";

    const last = messages.nth(count - 1);
    return (await last.innerText()).trim();
  }

  /** Wait for attachment element to appear after long text paste; returns whether it succeeded */
  private async waitForAttachment(timeout: number): Promise<boolean> {
    const sel = 'button[aria-label^="Remove file"]';
    try {
      await this.page.waitForSelector(sel, { state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** Wait for the send button to become clickable and submit; falls back to Enter key on timeout */
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

    // Fallback: use Enter key when no usable button is found
    const input = this.page.locator(
      await this.resolveSelector("messageInput")
    );
    await input.click();
    await this.page.keyboard.press("Enter");
  }

  getPageUrl(): string {
    return this.page.url();
  }

  /** Close the page tab */
  async close(): Promise<void> {
    await this.page.close().catch(() => {});
  }
}
