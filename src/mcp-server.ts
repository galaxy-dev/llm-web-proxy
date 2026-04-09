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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { startProxy } from "./index.js";

/** Read message content from a file path */
async function resolveMessage(messageFile: string): Promise<string> {
  return readFile(messageFile, "utf-8");
}

/** Write response content to a file, creating parent directories as needed.
 *  Returns a confirmation string with path and character count. */
async function writeResponseFile(filePath: string, content: string): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return `Response written to ${filePath} (${content.length} chars)`;
}

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
    "List all enabled LLM providers (e.g. chatgpt, claude). Use this to discover valid provider names before calling ask or session_create.",
    {},
    async () => mcpText(JSON.stringify(providers)),
  );

  // Health check: returns per-provider status
  server.tool(
    "health",
    "Check proxy service health and per-provider authentication status. Returns JSON with each provider's authenticated flag. Call this to verify a provider is ready before sending messages.",
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
    "Stateless one-shot Q&A: creates a temporary session, sends the message, writes the full LLM response to responseFile, then closes the session. No conversation history is retained. Best for single independent questions. For multi-turn conversations, use session_create + session_send instead. All I/O is file-based to avoid consuming your context window.",
    {
      provider: providerEnum.describe("LLM provider name (from provider_list)"),
      messageFile: z.string().describe("Absolute path to a file whose content will be sent as the message"),
      responseFile: z.string().describe("Absolute path to write the LLM response to"),
    },
    async ({ provider, messageFile, responseFile }) => {
      let content: string;
      try {
        content = await resolveMessage(messageFile);
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : String(err));
      }

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
      ownedSessions.add(sessionId);

      try {
        const chatResult = await parseOrError<{ response: string }>(
          await api(`/sessions/${sessionId}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: content }),
          }),
          "LLM error"
        );
        if ("error" in chatResult) return chatResult.error;

        try {
          return mcpText(await writeResponseFile(responseFile, chatResult.data.response));
        } catch (err) {
          return mcpError(`Failed to write response file: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        ownedSessions.delete(sessionId);
        await api(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    }
  );

  // Multi-turn conversation: create session
  server.tool(
    "session_create",
    "Open a new multi-turn conversation session with an LLM provider. Returns a sessionId to use with session_send. The session retains conversation history across messages. Close with session_close when done.",
    {
      provider: providerEnum.describe("LLM provider name (from provider_list)"),
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
    "Send a message in an existing multi-turn session and write the LLM's full response to responseFile. The session remembers prior messages, so follow-up questions work naturally. All I/O is file-based to avoid consuming your context window.",
    {
      sessionId: z.string().describe("Session ID returned by session_create"),
      messageFile: z.string().describe("Absolute path to a file whose content will be sent as the message"),
      responseFile: z.string().describe("Absolute path to write the LLM response to"),
    },
    async ({ sessionId, messageFile, responseFile }) => {
      let content: string;
      try {
        content = await resolveMessage(messageFile);
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : String(err));
      }

      if (!ownedSessions.has(sessionId) && !tryAdoptOrphan(sessionId, ownedSessions, clientId)) {
        return mcpError(`Session ${sessionId} not owned by this connection`);
      }
      const result = await parseOrError<{ response: string }>(
        await api(`/sessions/${sessionId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: content }),
        }),
        "Error"
      );
      if ("error" in result) return result.error;

      try {
        return mcpText(await writeResponseFile(responseFile, result.data.response));
      } catch (err) {
        return mcpError(`Failed to write response file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Batch send: fan-out concurrent requests within a single tool call
  server.tool(
    "session_send_batch",
    "Send messages to multiple sessions concurrently and write all responses to files. This is the recommended way to query multiple sessions in parallel — it bypasses MCP client serialization by fanning out requests server-side. Each item in the requests array has the same fields as session_send. All I/O is file-based to avoid consuming your context window.",
    {
      requests: z.array(z.object({
        sessionId: z.string().describe("Session ID returned by session_create"),
        messageFile: z.string().describe("Absolute path to a file whose content will be sent as the message"),
        responseFile: z.string().describe("Absolute path to write the LLM response to"),
      })).min(1).describe("Array of send requests to execute concurrently"),
    },
    async ({ requests }) => {
      const results = await Promise.allSettled(
        requests.map(async ({ sessionId, messageFile, responseFile }) => {
          const content = await resolveMessage(messageFile);

          if (!ownedSessions.has(sessionId) && !tryAdoptOrphan(sessionId, ownedSessions, clientId)) {
            throw new Error(`Session ${sessionId} not owned by this connection`);
          }
          const result = await parseOrError<{ response: string }>(
            await api(`/sessions/${sessionId}/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: content }),
            }),
            "Error"
          );
          if ("error" in result) {
            throw new Error(result.error.content[0].text);
          }

          return { sessionId, result: await writeResponseFile(responseFile, result.data.response) };
        })
      );

      const output = results.map((r, i) => {
        const sid = requests[i].sessionId;
        if (r.status === "fulfilled") {
          return r.value;
        }
        return { sessionId: sid, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
      });

      return mcpText(JSON.stringify(output, null, 2));
    }
  );

  // Multi-turn conversation: list sessions owned by this connection
  server.tool(
    "session_list",
    "List all active sessions owned by the current connection. Returns an array of objects with id and provider fields. Use this to find existing sessions before creating new ones.",
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
    "Get detailed info for a session (provider, creation time, message count). Only accessible for sessions owned by the current connection.",
    { sessionId: z.string().describe("Session ID returned by session_create") },
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
    "Close a session and release its resources (browser tab). Always close sessions when the conversation is finished to avoid resource leaks.",
    { sessionId: z.string().describe("Session ID returned by session_create") },
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
