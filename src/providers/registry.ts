// Provider registry: defines the contract each AI provider must implement
// and a simple lookup map for resolving providers by name.

import type { Page, BrowserContext } from "playwright";
import type { Config } from "../types.js";

/** Minimal contract for a provider page handler */
export interface ProviderPage {
  navigateToNewChat(): Promise<void>;
  /** Input text, paste, click send — browser-interactive, should run under browser lock */
  submitMessage(message: string): Promise<void>;
  /** Wait for assistant reply after submission — DOM polling, safe to run in parallel.
   *  @param timeout Response timeout in ms; scaled by message size when called from sendMessage. */
  awaitResponse(timeout?: number): Promise<string>;
  /** Convenience: submitMessage + awaitResponse in one call */
  sendMessage(message: string): Promise<string>;
  getPageUrl(): string;
  close(): Promise<void>;
}

/** Options passed to the page factory at session creation time */
export interface ProviderPageOptions {
  providerUrl: string;
  ephemeral: boolean;
}

/** Factory: given a Playwright Page, config, and provider options, construct a ProviderPage */
export type ProviderPageFactory = (page: Page, config: Config, options: ProviderPageOptions) => ProviderPage;

/** Check whether the browser is authenticated for this provider */
export type AuthChecker = (
  context: BrowserContext,
  config: Config,
  providerUrl: string,
) => Promise<boolean>;

/** Detect whether a page URL indicates auth has expired */
export type AuthExpiredDetector = (url: string) => boolean;

/** Everything needed to wire up a provider */
export interface ProviderDefinition {
  name: string;
  baseUrl: string;
  pageFactory: ProviderPageFactory;
  authChecker: AuthChecker;
  authExpiredDetector: AuthExpiredDetector;
}

/** Provider lookup map, populated by provider modules at import time */
export const PROVIDERS: Record<string, ProviderDefinition> = {};

export function registerProvider(def: ProviderDefinition): void {
  PROVIDERS[def.name] = def;
}
