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

  /** Input text, paste, click send — browser-interactive phase only.
   *  Records beforeCount for awaitResponse (inherited from base class). */
  async submitMessage(text: string): Promise<void> {
    this.beforeCount = await this.assistantMessages().count();
    this.lastMessageLength = text.length;

    const inputSel = await this.resolveSelector("messageInput");
    const input = this.page.locator(inputSel);
    await input.click();

    if (text.length > 2000 || text.includes("\n")) {
      await this.pasteViaClipboard(text);

      const attached = await this.waitForAttachment(10_000);

      if (attached) {
        await input.click();
        await input.pressSequentially(this.config.attachmentPrompt, {
          delay: 5,
        });
      } else {
        const composerText = await this.readComposerText(input);
        if (composerText.trim().length === 0) {
          throw new ProxyError(
            ErrorCode.PAGE_STRUCTURE_CHANGED,
            "Long text paste failed: no attachment or composer content detected"
          );
        }
      }
    } else {
      await input.pressSequentially(text, { delay: 5 });
    }

    await this.waitUntilSendReadyAndSubmit();
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
