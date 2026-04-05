// Config loading and validation: reads config.json, merges with defaults, and validates
//
// Loading strategy: DEFAULTS provides full defaults -> config.json overrides -> validateConfig validates.
// Runs with all defaults when config.json is absent, lowering the barrier for first-time use.
// timeouts and account are deep-merged at two levels; users only need to override the fields they want.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.js";

/** Default config, used when no config.json is provided */
const DEFAULTS: Config = {
  port: 3210,
  headless: true,
  provider: "chatgpt",
  providerUrl: "",
  maxSessions: 20,
  cdpPort: 9222,
  attachmentPrompt: "Please respond to the attached content.",
  account: {
    name: "default",
    storageStatePath: "./.llm-web-proxy/accounts/default.json",
  },
  timeouts: {
    navigation: 30_000,
    response: 120_000,
    stability: 2_000,
  },
  sseKeepaliveSec: 30,
  orphanGraceSec: 14_400,
};

/** Load config file, deep-merge with defaults, and return */
export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? resolve(process.cwd(), "config.json");

  if (!existsSync(filePath)) {
    console.log(`No config.json found, using defaults (port ${DEFAULTS.port})`);
    return DEFAULTS;
  }

  const raw = JSON.parse(readFileSync(filePath, "utf-8"));

  // Backward compat: migrate chatgptUrl -> providerUrl
  if (raw.chatgptUrl && !raw.providerUrl) {
    console.warn('config: "chatgptUrl" is deprecated, use "providerUrl" instead');
    raw.providerUrl = raw.chatgptUrl;
    delete raw.chatgptUrl;
  }

  const config: Config = {
    ...DEFAULTS,
    ...raw,
    timeouts: { ...DEFAULTS.timeouts, ...(raw.timeouts ?? {}) },
    account: { ...DEFAULTS.account, ...(raw.account ?? {}) },
  };

  validateConfig(config);
  return config;
}

/** Validate config fields */
function validateConfig(config: Config): void {
  assertPort("port", config.port);
  assertPort("cdpPort", config.cdpPort);
  assertPositiveInt("maxSessions", config.maxSessions);
  for (const [key, value] of Object.entries(config.timeouts)) {
    assertPositiveInt(`timeouts.${key}`, value);
  }
  if (!config.attachmentPrompt?.trim()) {
    config.attachmentPrompt = DEFAULTS.attachmentPrompt;
  }
  if (!config.account.name?.trim()) {
    throw new Error("config: account.name must be a non-empty string");
  }
}

function assertPort(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`config: ${name} must be an integer between 1 and 65535, got ${value}`);
  }
}

function assertPositiveInt(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`config: ${name} must be a positive integer, got ${value}`);
  }
}
