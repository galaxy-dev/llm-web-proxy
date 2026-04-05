// Claude page interaction layer: encapsulates input, send, wait for reply, and extract reply text DOM operations
//
// Adapts to Claude.ai's DOM structure via candidate selector lists.
// resolveSelector() probes candidates by priority and caches the match; retries on invalidation.
// Long text (>2000 chars) is sent via clipboard paste with a global mutex to prevent concurrent overwrites.
// Reply detection has two phases: streaming indicator disappears -> text stability check.
// Timeout scenarios carry partialResponse to avoid total loss after long waits.

import type { Page } from "playwright";
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
    "div.ProseMirror[contenteditable='true']",
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[data-testid="send-button"]',
    'fieldset button:has(> svg)',
  ],
  stopButton: [
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop"]',
  ],
};

/**
 * Assistant message selectors — targets the response content containers.
 * Queries the current DOM each time; not cached.
 */
const ASSISTANT_MESSAGE_SELECTORS = [
  "[data-is-streaming]",
  'div[data-testid="assistant-message"]',
  ".font-claude-message",
];

/** Encapsulates interaction with a single Claude.ai page tab */
export class ClaudePage implements ProviderPage {
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
    timeout = 3000,
  ): Promise<string> {
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
      `Unable to resolve visible selector for "${key}"`,
    );
  }

  /** Get a combined locator for all assistant messages (queries DOM each time, not cached) */
  private assistantMessages() {
    return this.page.locator(ASSISTANT_MESSAGE_SELECTORS.join(", "));
  }

  private stopButtonCombinedSelector(): string {
    return SELECTOR_CANDIDATES.stopButton.join(", ");
  }

  /** Navigate to a new conversation page */
  async navigateToNewChat(): Promise<void> {
    const query = this.ephemeral ? "?incognito" : "";
    await this.page.goto(`${this.providerUrl}/new${query}`, {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeouts.navigation,
    });

    await this.resolveSelector("messageInput", this.config.timeouts.navigation);
  }

  /** Send a message and wait for Claude's reply; returns the reply text */
  async sendMessage(text: string): Promise<string> {
    const beforeCount = await this.assistantMessages().count();

    const inputSel = await this.resolveSelector("messageInput");
    const input = this.page.locator(inputSel);
    await input.click();

    if (text.length > 2000 || text.includes("\n")) {
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

        await this.page
          .evaluate(async () => navigator.clipboard.writeText(""))
          .catch(() => {});
      } finally {
        releaseClipboard();
      }

      // Verify text was pasted into the composer
      await this.page.waitForTimeout(500);
      const composerText = await input.innerText().catch(() => "");
      if (composerText.trim().length === 0) {
        throw new ProxyError(
          ErrorCode.PAGE_STRUCTURE_CHANGED,
          "Long text paste failed: no composer content detected",
        );
      }
    } else {
      await input.pressSequentially(text, { delay: 5 });
    }

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
        "No new assistant message appeared — Claude page structure may have changed",
      );
    }

    await this.waitForResponseComplete();

    return this.getLastAssistantMessage();
  }

  /** Wait for Claude streaming response to complete: stop button disappears, then text stability check */
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
      try {
        await this.page.waitForSelector(stopSel, {
          state: "visible",
          timeout: 3000,
        });
      } catch {
        // Never appeared — reply may already be complete
      }
    }

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

    // Phase 2: text stability check
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

    const partialText = await this.getLastAssistantMessage();
    throw new ProxyError(
      ErrorCode.RESPONSE_TIMEOUT,
      "Timed out waiting for Claude response",
      partialText || undefined,
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

    // Fallback: use Enter key
    const input = this.page.locator(
      await this.resolveSelector("messageInput"),
    );
    await input.click();
    await this.page.keyboard.press("Enter");
  }

  getPageUrl(): string {
    return this.page.url();
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => {});
  }
}
