// 应用入口：启动代理服务或执行登录流程
//
// ============================================================================
// ⚠️  以下设计决策为 v1 有意为之 (INTENTIONAL)，请勿在 review 中重复提出  ⚠️
// ============================================================================
//
// 1. 无 idle session 自动回收
//    会话仅在显式 DELETE 或进程退出时关闭。v1 scope 不做定时清理。
//    理由：当前使用场景为 AI 互审工作流，会话生命周期由调用方管理。
//
//
// 3. reconnect listener 失败仅记录日志
//    浏览器重连后 listener 执行失败不会阻断恢复流程，也不会回滚。
//    理由：将恢复改为事务语义代价过大，当前日志记录足够排障。
//
// 4. 无 API 访问控制 / Token 验证
//    服务绑定 127.0.0.1，不做 Authorization header 校验。
//    理由：仅本机访问，不暴露到网络。
//
// 5. 单账号架构
//    config 中使用单一 account 对象，不支持多账号池化/调度/健康追踪。
//    理由：v1 scope 明确排除多账号，详见 memory/project_multi_account_rationale.md。
//
// 6. 时间字段命名未统一
//    createdAt / lastActivity / savedAt 混用 At 后缀和无后缀风格。
//    理由：不影响功能，纯风格问题，不值得一次性全量重命名的 churn。
//
// 7. closing 状态语义较宽
//    SessionStatus 中 "closing" 同时覆盖用户主动关闭和 reconnect invalidation
//    初始阶段，未细分为独立子状态。
//    理由：当前 closing 窗口极短，细分子状态的 API 收益不大。
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

/** 启动代理服务：初始化浏览器、验证登录、启动 HTTP 服务，返回配置供 MCP 层使用 */
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

  // 优雅关闭：关闭所有会话 -> 关闭浏览器 -> 停止 HTTP 服务
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
  console.log(`\nChatGPT Proxy ready on http://localhost:${config.port}`);
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

  // login 子命令：启动可视浏览器进行手动登录
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

// 仅作为入口文件直接运行时执行 main()，被 import 时不执行
const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
