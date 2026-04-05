// Claude provider definition: page factory, auth checker, auth-expiry detector

import { registerProvider, type ProviderDefinition } from "../registry.js";
import { ClaudePage } from "./page.js";

const claudeProvider: ProviderDefinition = {
  name: "claude",
  baseUrl: "https://claude.ai",

  pageFactory: (page, config, options) => new ClaudePage(page, config, options),

  authChecker: async (context, config, providerUrl) => {
    const page = await context.newPage();
    try {
      await page.goto(providerUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
      const url = page.url();
      return !url.includes("/login") && !url.includes("/oauth");
    } catch {
      return false;
    } finally {
      await page.close().catch(() => {});
    }
  },

  authExpiredDetector: (url) =>
    url.includes("/login") || url.includes("/oauth"),
};

registerProvider(claudeProvider);
