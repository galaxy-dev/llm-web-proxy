// ChatGPT provider definition: page factory, auth checker, auth-expiry detector

import { registerProvider, type ProviderDefinition } from "../registry.js";
import { ChatGPTPage } from "./page.js";

const chatgptProvider: ProviderDefinition = {
  name: "chatgpt",
  baseUrl: "https://chatgpt.com",

  pageFactory: (page, config) => new ChatGPTPage(page, config),

  authChecker: async (context, config) => {
    const page = await context.newPage();
    try {
      await page.goto(config.providerUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
      const url = page.url();
      const hasLoginButton = await page
        .locator('[data-testid="login-button"]')
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      return !url.includes("/auth") && !url.includes("/login") && !hasLoginButton;
    } catch {
      return false;
    } finally {
      await page.close().catch(() => {});
    }
  },

  authExpiredDetector: (url) =>
    url.includes("/auth") || url.includes("/login"),
};

registerProvider(chatgptProvider);
