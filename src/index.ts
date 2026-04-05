// Application entry point: starts the proxy server or runs the login flow
//
// ============================================================================
// The following design decisions are INTENTIONAL for v1; do not re-raise in reviews.
// ============================================================================
//
// 1. No idle session auto-reclaim
//    Sessions are only closed on explicit DELETE or process exit. No scheduled cleanup in v1.
//    Rationale: current use case is AI cross-review workflows; session lifecycle is caller-managed.
//
// 2. Reconnect listener failures are logged only
//    Listener failures after browser reconnection do not block recovery or trigger rollback.
//    Rationale: making recovery transactional is too costly; logging is sufficient for debugging.
//
// 3. No API access control / token verification
//    HTTP and MCP servers both bind to 127.0.0.1 with no Authorization header checks.
//    Rationale: local access only, not exposed to the network.
//
// 4. Single-account architecture
//    Config uses a single account object; no multi-account pooling/scheduling/health tracking.
//    Rationale: multi-account is explicitly out of v1 scope, see memory/project_multi_account_rationale.md.
//
// 5. Inconsistent time field naming
//    createdAt / lastActivity / savedAt mix "At" suffix and no-suffix styles.
//    Rationale: no functional impact; pure style issue, not worth a full-rename churn.
//
// 6. Broad "closing" state semantics
//    SessionStatus "closing" covers both user-initiated close and reconnect invalidation
//    in the initial phase, without distinct sub-states.
//    Rationale: closing window is very short; splitting into sub-states offers little API benefit.
//
// ============================================================================

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { Config } from "./types.js";
import { PROVIDERS, type ProviderDefinition } from "./providers/registry.js";
import type { ProviderRuntime } from "./session-manager.js";
import "./providers/chatgpt/index.js";
import "./providers/claude/index.js";
import { BrowserManager } from "./browser-manager.js";
import { SessionManager } from "./session-manager.js";
import { buildServer } from "./server.js";

/** Resolve enabled providers from config, validating against the provider registry */
function resolveEnabledProviders(config: Config): Map<string, ProviderDefinition> {
  const enabled = new Map<string, ProviderDefinition>();
  for (const [name, provConfig] of Object.entries(config.providers)) {
    if (!provConfig.enabled) continue;
    const provDef = PROVIDERS[name];
    if (!provDef) {
      throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
    }
    enabled.set(name, provDef);
  }
  if (enabled.size === 0) {
    throw new Error("No enabled providers found in config");
  }
  return enabled;
}

/** Get the resolved URL for a provider (config override or provider default) */
function getProviderUrl(config: Config, providerName: string, provDef: ProviderDefinition): string {
  return config.providers[providerName]?.providerUrl || provDef.baseUrl;
}

/** Check auth for all providers, run parallel login flow for unauthenticated ones */
async function ensureAllAuth(
  config: Config,
  browserManager: BrowserManager,
  enabledProviders: Map<string, ProviderDefinition>,
): Promise<void> {
  // Check auth for all enabled providers in parallel
  const authResults = await Promise.all(
    [...enabledProviders.entries()].map(async ([name, provDef]) => {
      const url = getProviderUrl(config, name, provDef);
      const authed = await browserManager.checkProviderAuth(name, provDef.authChecker, url);
      return { name, provDef, authed };
    }),
  );

  const unauthenticated = authResults.filter((r) => !r.authed);
  if (unauthenticated.length === 0) return;

  console.log(`Auth needed for: ${unauthenticated.map((r) => r.name).join(", ")}`);

  // Close headless browser, open visible browser for login
  await browserManager.close();
  await browserManager.loginFlowMulti(
    unauthenticated.map((r) => ({
      name: r.name,
      baseUrl: getProviderUrl(config, r.name, r.provDef),
    })),
  );

  // Relaunch headless browser and re-verify auth
  await browserManager.launch();
  for (const { name, provDef } of unauthenticated) {
    const url = getProviderUrl(config, name, provDef);
    const authed = await browserManager.checkProviderAuth(name, provDef.authChecker, url);
    if (!authed) {
      console.warn(`Warning: ${name} still not authenticated after login flow`);
    }
  }
}

/** Initialize browser and ensure all providers are authenticated */
async function initBrowser(config: Config): Promise<{
  browserManager: BrowserManager;
  enabledProviders: Map<string, ProviderDefinition>;
}> {
  const enabledProviders = resolveEnabledProviders(config);
  const browserManager = new BrowserManager(config);
  await browserManager.launch();
  await ensureAllAuth(config, browserManager, enabledProviders);
  return { browserManager, enabledProviders };
}

/** Start the proxy service: init browser, verify login, start HTTP server; returns config for MCP layer */
export async function startProxy(): Promise<Config> {
  const config = loadConfig();
  const { browserManager, enabledProviders } = await initBrowser(config);

  // Build provider runtimes for SessionManager
  const providerRuntimes = new Map<string, ProviderRuntime>();
  for (const [name, provDef] of enabledProviders) {
    providerRuntimes.set(name, {
      pageFactory: provDef.pageFactory,
      authExpiredDetector: provDef.authExpiredDetector,
      providerUrl: getProviderUrl(config, name, provDef),
      ephemeral: config.providers[name].ephemeral,
    });
  }

  const sessionManager = new SessionManager(config, browserManager, providerRuntimes);

  const enabledNames = [...enabledProviders.keys()];
  const server = buildServer(sessionManager, browserManager, enabledNames);

  // Graceful shutdown: close all sessions -> close browser -> stop HTTP server
  const shutdown = async () => {
    console.log("\nShutting down...");
    await sessionManager.closeAll();
    await browserManager.close();
    await server.close();
  };

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });

  await server.listen({ port: config.port, host: "127.0.0.1" });
  console.log(`\nLLM Web Proxy ready on http://localhost:${config.port}`);
  console.log(`Account: ${config.account.name}`);
  console.log(`Providers: ${enabledNames.join(", ")}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET    /health             - Health check (per-provider status)`);
  console.log(`  POST   /sessions           - Create session (requires provider)`);
  console.log(`  GET    /sessions           - List sessions`);
  console.log(`  GET    /sessions/:id       - Get session`);
  console.log(`  POST   /sessions/:id/chat  - Send message`);
  console.log(`  DELETE /sessions/:id       - Close session`);

  return config;
}

async function main() {
  const args = process.argv.slice(2);

  // "login" subcommand: force open visible browser for manual login of all providers
  if (args[0] === "login") {
    const config = loadConfig();
    const enabledProviders = resolveEnabledProviders(config);
    const browserManager = new BrowserManager(config);
    await browserManager.loginFlowMulti(
      [...enabledProviders.entries()].map(([name, provDef]) => ({
        name,
        baseUrl: getProviderUrl(config, name, provDef),
      })),
    );
    await browserManager.close();
    process.exit(0);
  }

  try {
    await startProxy();
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

// Only run main() when executed as the entry file; skip when imported
const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
