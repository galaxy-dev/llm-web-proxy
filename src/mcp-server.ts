// MCP 服务器：将 ChatGPT 代理能力暴露为 MCP 工具
//
// 架构：proxy HTTP 服务 + SSE MCP 端点一体启动（--http 模式）
//   每个 GET /sse 创建独立的 McpServer + SSEServerTransport；
//   POST /message 通过 ?sessionId 路由到对应连接
//
// 会话隔离与保活：
//   每个 MCP 连接维护自己的 ownedSessions 集合，只能操作自己创建的 proxy session。
//   SSE 连接每 30s 发送 :ping 心跳保活，防止空闲超时断连。
//   SSE 断开时 session 不立即删除，而是放入 orphan pool 等待 60s；
//   新连接可通过使用 session ID 自动认领（adopt）孤儿 session，超时未认领才删除。

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { startProxy } from "./index.js";

const PROXY_URL = process.env.CHATGPT_PROXY_URL ?? "http://localhost:3210";

/** Populated by main() after config is loaded */
let SSE_KEEPALIVE_INTERVAL_MS = 30_000;
let ORPHAN_GRACE_PERIOD_MS = 60_000;

/** Sessions orphaned by a disconnected SSE connection, awaiting adoption or deletion */
const orphanPool = new Map<string, { timer: NodeJS.Timeout; fromClient: string }>();

/** Move a session to the orphan pool with a timed deletion */
function orphanSession(sessionId: string, clientId: string): void {
  const existing = orphanPool.get(sessionId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    orphanPool.delete(sessionId);
    api(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
    console.error(`Orphaned session ${sessionId} expired — deleted`);
  }, ORPHAN_GRACE_PERIOD_MS);

  timer.unref();
  orphanPool.set(sessionId, { timer, fromClient: clientId });
  console.error(`Session ${sessionId} orphaned by ${clientId} (grace: ${ORPHAN_GRACE_PERIOD_MS}ms)`);
}

/** Try to adopt an orphaned session into the current connection's ownedSessions */
function tryAdoptOrphan(sessionId: string, ownedSessions: Set<string>, clientId: string): boolean {
  const entry = orphanPool.get(sessionId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  const from = entry.fromClient;
  orphanPool.delete(sessionId);
  ownedSessions.add(sessionId);
  console.error(`${clientId} adopted session ${sessionId} (from ${from})`);
  return true;
}

/** 向代理服务发起 HTTP 请求 */
async function api(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${PROXY_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Cannot reach chatgpt-proxy at ${PROXY_URL} — is it running? (${err instanceof Error ? err.message : err})`
    );
  }
}

/** 安全解析 JSON 响应体，非 JSON 时抛出描述性错误 */
async function safeJson<T = unknown>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from proxy but got: ${text.slice(0, 200)}`
    );
  }
}

/** 构造 MCP 错误响应 */
function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** 构造 MCP 文本响应 */
function mcpText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** 解析代理响应：成功返回 data，失败返回 MCP 错误 */
async function parseOrError<T>(
  res: Response,
  prefix: string
): Promise<{ data: T } | { error: ReturnType<typeof mcpError> }> {
  if (!res.ok) {
    const body = await safeJson<{ message?: string; partialResponse?: string }>(res);
    const msg = body?.message ?? `HTTP ${res.status}`;
    const partial = body?.partialResponse ? `\n\nPartial response:\n${body.partialResponse}` : "";
    return { error: mcpError(`${prefix}: ${msg}${partial}`) };
  }
  const data = await safeJson<T>(res);
  if (data == null) {
    return { error: mcpError(`${prefix}: empty response body`) };
  }
  return { data };
}

/** Register all MCP tools on the given server instance, scoped to ownedSessions */
function registerTools(server: McpServer, ownedSessions: Set<string>, clientId: string, providerName: string) {
  // 健康检查工具
  server.tool(
    `${providerName}_health`,
    "Check if the ChatGPT proxy service is running.",
    {},
    async () => {
      try {
        const res = await api("/health");
        const data = await safeJson(res);
        return mcpText(data != null ? JSON.stringify(data) : "healthy");
      } catch (err) {
        return mcpError(`Proxy unreachable: ${err instanceof Error ? err.message : err}`);
      }
    }
  );

  // 一次性问答：自动创建会话 -> 发送 -> 获取回复 -> 关闭（天然隔离，无需归属管理）
  server.tool(
    `${providerName}_ask`,
    "Send a message to ChatGPT and get a response. Auto-manages session lifecycle.",
    { message: z.string().describe("The message to send to ChatGPT") },
    async ({ message }) => {
      const createResult = await parseOrError<{ sessionId: string }>(
        await api("/sessions", { method: "POST" }),
        "Failed to create session"
      );
      if ("error" in createResult) return createResult.error;
      const { sessionId } = createResult.data;

      try {
        const chatResult = await parseOrError<{ response: string }>(
          await api(`/sessions/${sessionId}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          }),
          "ChatGPT error"
        );
        if ("error" in chatResult) return chatResult.error;
        return mcpText(chatResult.data.response);
      } finally {
        await api(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    }
  );

  // 多轮对话：创建会话
  server.tool(
    `${providerName}_session_create`,
    "Create a new ChatGPT session for multi-turn conversation. Returns a session ID.",
    {},
    async () => {
      const result = await parseOrError<{ sessionId: string }>(
        await api("/sessions", { method: "POST" }),
        "Failed"
      );
      if ("error" in result) return result.error;
      ownedSessions.add(result.data.sessionId);
      return mcpText(result.data.sessionId);
    }
  );

  // 多轮对话：发送消息
  server.tool(
    `${providerName}_session_send`,
    "Send a message to an existing ChatGPT session.",
    {
      sessionId: z.string().describe("The session ID"),
      message: z.string().describe("The message to send"),
    },
    async ({ sessionId, message }) => {
      if (!ownedSessions.has(sessionId) && !tryAdoptOrphan(sessionId, ownedSessions, clientId)) {
        return mcpError(`Session ${sessionId} not owned by this connection`);
      }
      const result = await parseOrError<{ response: string }>(
        await api(`/sessions/${sessionId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }),
        "Error"
      );
      if ("error" in result) return result.error;
      return mcpText(result.data.response);
    }
  );

  // 多轮对话：列出本连接创建的会话
  server.tool(
    `${providerName}_session_list`,
    "List active ChatGPT sessions owned by this connection.",
    {},
    async () => {
      const result = await parseOrError<{ id: string }[]>(
        await api("/sessions"),
        "Failed"
      );
      if ("error" in result) return result.error;
      // Auto-adopt any orphaned sessions into this connection
      for (const s of result.data) {
        if (!ownedSessions.has(s.id)) {
          tryAdoptOrphan(s.id, ownedSessions, clientId);
        }
      }
      const owned = result.data.filter((s) => ownedSessions.has(s.id));
      return mcpText(JSON.stringify(owned, null, 2));
    }
  );

  // 多轮对话：查询会话详情
  server.tool(
    `${providerName}_session_get`,
    "Get info for a specific ChatGPT session. Returns error if not owned by this connection.",
    { sessionId: z.string().describe("The session ID") },
    async ({ sessionId }) => {
      if (!ownedSessions.has(sessionId) && !tryAdoptOrphan(sessionId, ownedSessions, clientId)) {
        return mcpError(`Session ${sessionId} not owned by this connection`);
      }
      const result = await parseOrError<Record<string, unknown>>(
        await api(`/sessions/${sessionId}`),
        "Failed"
      );
      if ("error" in result) return result.error;
      return mcpText(JSON.stringify(result.data, null, 2));
    }
  );

  // 多轮对话：关闭会话
  server.tool(
    `${providerName}_session_close`,
    "Close a ChatGPT session owned by this connection.",
    { sessionId: z.string().describe("The session ID to close") },
    async ({ sessionId }) => {
      if (!ownedSessions.has(sessionId) && !tryAdoptOrphan(sessionId, ownedSessions, clientId)) {
        return mcpError(`Session ${sessionId} not owned by this connection`);
      }
      const res = await api(`/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) {
        const result = await parseOrError<never>(res, "Failed");
        if ("error" in result) return result.error;
      }
      ownedSessions.delete(sessionId);
      return mcpText(`Session ${sessionId} closed`);
    }
  );
}

/** Create a new McpServer with all tools registered, returns owned session tracker */
function createMcpServer(clientId: string, providerName: string): { server: McpServer; ownedSessions: Set<string> } {
  const server = new McpServer({
    name: `${providerName}-proxy`,
    version: "0.1.0",
  });
  const ownedSessions = new Set<string>();
  registerTools(server, ownedSessions, clientId, providerName);
  return { server, ownedSessions };
}

async function main() {
  // 启动代理 HTTP 服务，获取配置
  const config = await startProxy();
  SSE_KEEPALIVE_INTERVAL_MS = config.sseKeepaliveSec * 1000;
  ORPHAN_GRACE_PERIOD_MS = config.orphanGraceSec * 1000;

  const port = parseInt(process.env.MCP_PORT ?? "3211");
  const transports = new Map<string, SSEServerTransport>();
  let clientSeq = 0;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      const clientId = `[${config.provider}-proxy:sse-client:${++clientSeq}]`;
      const { server, ownedSessions } = createMcpServer(clientId, config.provider);
      const transport = new SSEServerTransport("/message", res);
      transports.set(transport.sessionId, transport);
      console.error(`${clientId} connected (total: ${transports.size})`);

      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

      res.on("close", () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        transports.delete(transport.sessionId);
        // Move owned sessions to orphan pool instead of deleting immediately
        for (const sid of ownedSessions) {
          orphanSession(sid, clientId);
        }
        ownedSessions.clear();
        server.close().catch(() => {});
        console.error(`${clientId} disconnected (total: ${transports.size})`);
      });

      await server.connect(transport);

      // Send SSE comments periodically to keep the connection alive
      keepaliveTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(":ping\n\n");
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessionId ? transports.get(sessionId) : null;
      if (!transport) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown or expired SSE session" }));
        return;
      }
      // 读取请求体，限制 1MB 防止滥用
      const MAX_BODY = 1_048_576;
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      await transport.handlePostMessage(req, res, parsed);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`MCP server (SSE) listening on http://0.0.0.0:${port}/sse`);
  });
}

main();
