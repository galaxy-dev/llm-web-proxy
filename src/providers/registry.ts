// Provider registry: defines the contract each AI provider must implement
// and a simple lookup map for resolving providers by name.

import type { Page, BrowserContext } from "playwright";
import type { Config } from "../types.js";

/** Minimal contract for a provider page handler */
export interface ProviderPage {
  navigateToNewChat(): Promise<void>;
  sendMessage(message: string): Promise<string>;
  getPageUrl(): string;
  close(): Promise<void>;
}

/** Factory: given a Playwright Page, config, and resolved provider URL, construct a ProviderPage */
export type ProviderPageFactory = (page: Page, config: Config, providerUrl: string) => ProviderPage;

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
