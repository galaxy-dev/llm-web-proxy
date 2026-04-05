// ChatGPT page interaction layer: encapsulates input, send, wait for reply, and extract reply text DOM operations
//
// Extends BaseProviderPage for shared DOM patterns (selector resolution, response streaming, etc).
// Long text (>2000 chars) is sent via clipboard paste with a global mutex to prevent concurrent overwrites.
// ChatGPT-specific: long pastes may generate a file attachment; handled via waitForAttachment.

import type { Page, Locator } from "playwright";
import type { Config } from "../../types.js";
import { ProxyError, ErrorCode } from "../../errors.js";
import type { ProviderPageOptions } from "../registry.js";
import { BaseProviderPage } from "../base-page.js";
import { acquireClipboard, releaseClipboard } from "../../clipboard-mutex.js";

/** Candidate selector lists for ChatGPT interactive elements */
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

/** Assistant message selectors for ChatGPT */
const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  ".agent-turn",
];

/** Encapsulates interaction with a single ChatGPT page tab */
export class ChatGPTPage extends BaseProviderPage {
  protected readonly SELECTOR_CANDIDATES = SELECTOR_CANDIDATES;
  protected readonly ASSISTANT_MESSAGE_SELECTORS = ASSISTANT_MESSAGE_SELECTORS;

  constructor(page: Page, config: Config, options: ProviderPageOptions) {
    super(page, config, options);
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
}
