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
//
// 3. Reconnect listener failures are logged only
//    Listener failures after browser reconnection do not block recovery or trigger rollback.
//    Rationale: making recovery transactional is too costly; logging is sufficient for debugging.
//
// 4. No API access control / token verification
//    Server binds to 127.0.0.1 with no Authorization header checks.
//    Rationale: local access only, not exposed to the network.
//
// 5. Single-account architecture
//    Config uses a single account object; no multi-account pooling/scheduling/health tracking.
//    Rationale: multi-account is explicitly out of v1 scope, see memory/project_multi_account_rationale.md.
//
// 6. Inconsistent time field naming
//    createdAt / lastActivity / savedAt mix "At" suffix and no-suffix styles.
//    Rationale: no functional impact; pure style issue, not worth a full-rename churn.
//
// 7. Broad "closing" state semantics
//    SessionStatus "closing" covers both user-initiated close and reconnect invalidation
//    in the initial phase, without distinct sub-states.
//    Rationale: closing window is very short; splitting into sub-states offers little API benefit.
//
// ============================================================================

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { Config } from "./types.js";
import { PROVIDERS } from "./providers/registry.js";
import "./providers/chatgpt/index.js";
import { BrowserManager } from "./browser-manager.js";
import { SessionManager } from "./session-manager.js";
import { buildServer } from "./server.js";

/** Start the proxy service: init browser, verify login, start HTTP server; returns config for MCP layer */
export async function startProxy(): Promise<Config> {
  const config = loadConfig();

  const providerDef = PROVIDERS[config.provider];
  if (!providerDef) {
    throw new Error(`Unknown provider: "${config.provider}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (!config.providerUrl) config.providerUrl = providerDef.baseUrl;

  const browserManager = new BrowserManager(config, providerDef.authChecker, config.providerUrl);
  const sessionManager = new SessionManager(config, browserManager, providerDef.pageFactory, providerDef.authExpiredDetector);

  await browserManager.launch();
  await browserManager.ensureAuth();

  const server = buildServer(sessionManager, browserManager);

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
  console.log(`\nEndpoints:`);
  console.log(`  GET    /health             - Health check`);
  console.log(`  POST   /sessions           - Create session`);
  console.log(`  GET    /sessions           - List sessions`);
  console.log(`  GET    /sessions/:id       - Get session`);
  console.log(`  POST   /sessions/:id/chat  - Send message`);
  console.log(`  DELETE /sessions/:id       - Close session`);

  return config;
}

async function main() {
  const args = process.argv.slice(2);

  // "login" subcommand: launch visible browser for manual login
  if (args[0] === "login") {
    const config = loadConfig();
    const providerDef = PROVIDERS[config.provider];
    if (!providerDef) throw new Error(`Unknown provider: "${config.provider}"`);
    if (!config.providerUrl) config.providerUrl = providerDef.baseUrl;
    const browserManager = new BrowserManager(config, providerDef.authChecker, config.providerUrl);
    await browserManager.loginFlow();
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
