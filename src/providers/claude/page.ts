// Claude page interaction layer: encapsulates input, send, wait for reply, and extract reply text DOM operations
//
// Extends BaseProviderPage for shared DOM patterns (selector resolution, response streaming, etc).
// Long text (>2000 chars) is sent via clipboard paste with a global mutex to prevent concurrent overwrites.
// Claude-specific: very long pastes create a "PASTED" attachment card; detected via send button state.

import type { Page } from "playwright";
import type { Config } from "../../types.js";
import { ProxyError, ErrorCode } from "../../errors.js";
import type { ProviderPageOptions } from "../registry.js";
import { BaseProviderPage } from "../base-page.js";
import { acquireClipboard, releaseClipboard } from "../../clipboard-mutex.js";

/** Candidate selector lists for Claude interactive elements */
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

/** Assistant message selectors for Claude */
const ASSISTANT_MESSAGE_SELECTORS = [
  "[data-is-streaming]",
  'div[data-testid="assistant-message"]',
  ".font-claude-message",
];

/** Encapsulates interaction with a single Claude.ai page tab */
export class ClaudePage extends BaseProviderPage {
  protected readonly SELECTOR_CANDIDATES = SELECTOR_CANDIDATES;
  protected readonly ASSISTANT_MESSAGE_SELECTORS = ASSISTANT_MESSAGE_SELECTORS;

  constructor(page: Page, config: Config, options: ProviderPageOptions) {
    super(page, config, options);
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

      // After pasting long text, Claude may convert it to a "PASTED" attachment card.
      // When that happens the composer text is empty but the send button is active.
      // Unlike ChatGPT, Claude doesn't need a separate prompt — the PASTED card IS the content.
      // Verify paste succeeded by checking: composer has text OR send button became enabled.
      await this.page.waitForTimeout(2000);

      const composerText = await input.innerText().catch(() => "");
      if (composerText.trim().length === 0) {
        // Composer empty — wait for send button to become active (indicates attachment was created)
        const pasteOk = await this.waitForSendButtonActive(8_000);
        if (!pasteOk) {
          throw new ProxyError(
            ErrorCode.PAGE_STRUCTURE_CHANGED,
            "Long text paste failed: no attachment or composer content detected",
          );
        }
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

  /** Wait for the send button to become active (not disabled); used to verify paste/attachment success */
  private async waitForSendButtonActive(timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const sel of this.SELECTOR_CANDIDATES.sendButton) {
        const btn = this.page.locator(sel).first();
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        const disabled = await btn
          .evaluate((el) => (el as HTMLButtonElement).disabled)
          .catch(() => true);
        if (!disabled) return true;
      }
      await this.page.waitForTimeout(500);
    }
    return false;
  }
}
