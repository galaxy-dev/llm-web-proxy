// Shared base class for LLM provider page interaction.
//
// Encapsulates common DOM interaction patterns: selector resolution with caching,
// assistant message tracking, response streaming detection (stop button + text stability),
// and send button handling. Subclasses provide provider-specific selectors and
// implement sendMessage / navigateToNewChat for their respective UIs.

import type { Page } from "playwright";
import type { Config } from "../types.js";
import { ProxyError, ErrorCode } from "../errors.js";
import type { ProviderPage, ProviderPageOptions } from "./registry.js";

/** Candidate selector lists keyed by role (e.g. messageInput, sendButton, stopButton) */
export type SelectorCandidates = Record<string, string[]>;

/** Base class for provider page implementations */
export abstract class BaseProviderPage implements ProviderPage {
  protected page: Page;
  protected config: Config;
  protected providerUrl: string;
  protected ephemeral: boolean;
  /** Resolved selector cache to avoid repeated probing */
  protected resolved: Record<string, string> = {};

  /** Subclasses define candidate selectors for interactive elements */
  protected abstract readonly SELECTOR_CANDIDATES: SelectorCandidates;
  /** Subclasses define selectors for assistant message containers */
  protected abstract readonly ASSISTANT_MESSAGE_SELECTORS: string[];

  constructor(page: Page, config: Config, options: ProviderPageOptions) {
    this.page = page;
    this.config = config;
    this.providerUrl = options.providerUrl;
    this.ephemeral = options.ephemeral;
  }

  abstract sendMessage(text: string): Promise<string>;
  abstract navigateToNewChat(): Promise<void>;

  /**
   * Resolve a visible interactive element selector from the candidate list and cache it.
   * Throws PAGE_STRUCTURE_CHANGED when none of the candidates are visible.
   */
  protected async resolveSelector(
    key: string,
    timeout = 3000,
  ): Promise<string> {
    const candidates = this.SELECTOR_CANDIDATES[key];
    if (!candidates) {
      throw new ProxyError(
        ErrorCode.PAGE_STRUCTURE_CHANGED,
        `No selector candidates defined for "${key}"`,
      );
    }

    // Fast path: check if the cached selector is still visible
    if (this.resolved[key]) {
      const visible = await this.page
        .locator(this.resolved[key])
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return this.resolved[key];
      delete this.resolved[key];
    }

    // Probe all candidates (skipping the invalidated cached one to avoid double-check)
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
  protected assistantMessages() {
    return this.page.locator(this.ASSISTANT_MESSAGE_SELECTORS.join(", "));
  }

  protected stopButtonCombinedSelector(): string {
    return this.SELECTOR_CANDIDATES.stopButton.join(", ");
  }

  /**
   * Wait for streaming response to complete: stop button disappears, then text stability check.
   * Uses wall-clock timestamps for stability measurement to avoid polling-interval drift.
   */
  protected async waitForResponseComplete(): Promise<void> {
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

    // Phase 2: text stability check using wall-clock timestamps.
    // After stop button clears, even an empty response is considered stable
    // (the LLM may legitimately return nothing).
    const effectiveStability = stopButtonCleared ? checkInterval : stabilityMs;
    let lastText = "";
    let stableFrom: number | null = null;

    while (Date.now() < deadline) {
      const currentText = await this.getLastAssistantMessage();

      const textStable = currentText === lastText;
      const canSettle = stopButtonCleared || currentText.length > 0;
      if (textStable && canSettle) {
        stableFrom ??= Date.now();
        if (Date.now() - stableFrom >= effectiveStability) return;
      } else {
        stableFrom = null;
        lastText = currentText;
      }

      await this.page.waitForTimeout(checkInterval);
    }

    const partialText = await this.getLastAssistantMessage();
    throw new ProxyError(
      ErrorCode.RESPONSE_TIMEOUT,
      "Timed out waiting for response",
      partialText || undefined,
    );
  }

  /** Extract the text of the last assistant message */
  protected async getLastAssistantMessage(): Promise<string> {
    const messages = this.assistantMessages();
    const count = await messages.count();
    if (count === 0) return "";

    const last = messages.nth(count - 1);
    return (await last.innerText()).trim();
  }

  /** Wait for the send button to become clickable and submit; falls back to Enter key on timeout */
  protected async waitUntilSendReadyAndSubmit(): Promise<void> {
    const deadline = Date.now() + this.config.timeouts.navigation;

    while (Date.now() < deadline) {
      for (const sel of this.SELECTOR_CANDIDATES.sendButton) {
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
