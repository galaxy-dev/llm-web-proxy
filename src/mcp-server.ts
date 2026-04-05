// MCP server: exposes LLM web proxy capabilities as MCP tools
//
// Architecture: proxy HTTP service + SSE MCP endpoint launched together (--http mode).
//   Each GET /sse creates an independent McpServer + SSEServerTransport;
//   POST /message routes to the corresponding connection via ?sessionId.
//
// Tools are provider-agnostic: ask/session_create take a "provider" param,
// session_send/list/get/close operate by sessionId (provider is implicit).
// provider_list and health return info about all enabled providers.
//
// Session isolation and keepalive:
//   Each MCP connection maintains its own ownedSessions set, only operating on sessions it created.
//   SSE connections send :ping heartbeats every 30s to prevent idle timeout disconnects.
//   On SSE disconnect, sessions are not deleted immediately but placed in an orphan pool;
//   new connections can adopt orphaned sessions by referencing the session ID; unclaimed ones are deleted.

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { startProxy } from "./index.js";

const PROXY_URL = process.env.LLM_WEB_PROXY_URL ?? "http://localhost:3210";

/** Populated by main() after config is loaded */
let SSE_KEEPALIVE_INTERVAL_MS = 30_000;
let ORPHAN_GRACE_PERIOD_MS = 14_400_000;
/** Enabled provider names, set once by main() before any connections are accepted */
let ENABLED_PROVIDERS: string[] = [];

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

/** Send an HTTP request to the proxy service */
async function api(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${PROXY_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Cannot reach llm-web-proxy at ${PROXY_URL} — is it running? (${err instanceof Error ? err.message : err})`
    );
  }
}

/** Safely parse a JSON response body; throws a descriptive error for non-JSON */
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

/** Build an MCP error response */
function mcpError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Build an MCP text response */
function mcpText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Parse proxy response: returns data on success, MCP error on failure */
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

/** Register all MCP tools on the given server instance, scoped to ownedSessions.
 *  providers is passed explicitly to avoid depending on module-level mutable state timing. */
function registerTools(server: McpServer, ownedSessions: Set<string>, clientId: string, providers: string[]) {
  const providerEnum = z.enum(providers as [string, ...string[]]);

  // List available providers
  server.tool(
    "provider_list",
    "List all available LLM providers.",
    {},
    async () => mcpText(JSON.stringify(providers)),
  );

  // Health check: returns per-provider status
  server.tool(
    "health",
    "Check if the LLM web proxy service is running and get per-provider auth status.",
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

  // One-shot Q&A: auto create session -> send -> get reply -> close
  server.tool(
    "ask",
    "Send a message to the LLM and get a response. Auto-manages session lifecycle.",
    {
      provider: providerEnum.describe("The LLM provider to use"),
      message: z.string().describe("The message to send to the LLM"),
    },
    async ({ provider, message }) => {
      const createResult = await parseOrError<{ sessionId: string }>(
        await api("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        }),
        "Failed to create session"
      );
      if ("error" in createResult) return createResult.error;
      const { sessionId } = createResult.data;
      // Track for orphan cleanup if SSE disconnects before DELETE completes
      ownedSessions.add(sessionId);

      try {
        const chatResult = await parseOrError<{ response: string }>(
          await api(`/sessions/${sessionId}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          }),
          "LLM error"
        );
        if ("error" in chatResult) return chatResult.error;
        return mcpText(chatResult.data.response);
      } finally {
        ownedSessions.delete(sessionId);
        await api(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    }
  );

  // Multi-turn conversation: create session
  server.tool(
    "session_create",
    "Create a new LLM session for multi-turn conversation. Returns a session ID.",
    {
      provider: providerEnum.describe("The LLM provider to use"),
    },
    async ({ provider }) => {
      const result = await parseOrError<{ sessionId: string }>(
        await api("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        }),
        "Failed"
      );
      if ("error" in result) return result.error;
      ownedSessions.add(result.data.sessionId);
      return mcpText(result.data.sessionId);
    }
  );

  // Multi-turn conversation: send message
  server.tool(
    "session_send",
    "Send a message to an existing LLM session.",
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

  // Multi-turn conversation: list sessions owned by this connection
  server.tool(
    "session_list",
    "List active LLM sessions owned by this connection (includes provider info).",
    {},
    async () => {
      const result = await parseOrError<{ id: string; provider: string }[]>(
        await api("/sessions"),
        "Failed"
      );
      if ("error" in result) return result.error;
      const owned = result.data.filter((s) => ownedSessions.has(s.id));
      return mcpText(JSON.stringify(owned, null, 2));
    }
  );

  // Multi-turn conversation: get session details
  server.tool(
    "session_get",
    "Get info for a specific LLM session. Returns error if not owned by this connection.",
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

  // Multi-turn conversation: close session
  server.tool(
    "session_close",
    "Close an LLM session owned by this connection.",
    { sessionId: z.string().describe("The session ID to close") },
    async ({ sessionId }) => {
      if (!ownedSessions.has(sessionId) && !tryAdoptOrphan(sessionId, ownedSessions, clientId)) {
        return mcpError(`Session ${sessionId} not owned by this connection`);
      }
      const res = await api(`/sessions/${sessionId}`, { method: "DELETE" });
      // Treat 404/410 as successful close (session already gone or closed)
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        const result = await parseOrError<never>(res, "Failed");
        if ("error" in result) return result.error;
      }
      ownedSessions.delete(sessionId);
      return mcpText(`Session ${sessionId} closed`);
    }
  );
}

/** Create a new McpServer with all tools registered, returns owned session tracker */
function createMcpServer(clientId: string): { server: McpServer; ownedSessions: Set<string> } {
  const server = new McpServer({
    name: "llm-web-proxy",
    version: "0.1.0",
  });
  const ownedSessions = new Set<string>();
  registerTools(server, ownedSessions, clientId, ENABLED_PROVIDERS);
  return { server, ownedSessions };
}

async function main() {
  // Start the proxy HTTP service and get config
  const config = await startProxy();
  SSE_KEEPALIVE_INTERVAL_MS = config.sseKeepaliveSec * 1000;
  ORPHAN_GRACE_PERIOD_MS = config.orphanGraceSec * 1000;

  // Collect enabled provider names
  ENABLED_PROVIDERS = Object.entries(config.providers)
    .filter(([, p]) => p.enabled)
    .map(([name]) => name);

  const rawPort = process.env.MCP_PORT ?? "3211";
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT: ${rawPort}`);
  }
  const transports = new Map<string, SSEServerTransport>();
  let clientSeq = 0;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      const clientId = `[llm-proxy:sse-client:${++clientSeq}]`;
      const { server, ownedSessions } = createMcpServer(clientId);
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
      // Read request body, limited to 1MB to prevent abuse
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

  // Clean up orphan timers on shutdown to allow clean process exit
  const cleanupOrphans = () => {
    for (const { timer } of orphanPool.values()) clearTimeout(timer);
    orphanPool.clear();
  };
  process.on("SIGINT", cleanupOrphans);
  process.on("SIGTERM", cleanupOrphans);

  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`MCP server (SSE) listening on http://127.0.0.1:${port}/sse`);
  });
}

main();
