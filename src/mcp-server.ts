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
// Access control (3211 only): configured via config.json's `mcp` section
// ({ host, port, authToken }), with env overrides MCP_HOST / MCP_PORT / MCP_AUTH_TOKEN
// taking priority. To serve a remote/VM client set mcp.host="0.0.0.0" and a non-empty
// mcp.authToken; every request then requires `Authorization: Bearer <token>`. The HTTP
// proxy (3210) is never exposed — it stays loopback-only as the internal MCP->HTTP hop.
//
// File-based remote chat (B-direct): the MCP file tools take filesystem paths read/written
// by THIS process, which only works when client and server share a filesystem. For an
// isolated client (e.g. a Parallels VM with no mount) two raw-HTTP endpoints carry content
// over the wire instead — request body = prompt, response body = reply:
//   POST /ask-file?provider=NAME       one-shot (auto session lifecycle)
//   POST /sessions/:id/chat-file       multi-turn (session from session_create)
// The agent assembles/consumes the files via shell + curl, so large content never enters
// its context. Both forward to the loopback proxy's chat endpoint and reuse the auth gate.
//
// Session isolation and keepalive:
//   Each MCP connection maintains its own ownedSessions set, only operating on sessions it created.
//   SSE connections send :ping heartbeats every 30s to prevent idle timeout disconnects.
//   On SSE disconnect, sessions are not deleted immediately but placed in an orphan pool;
//   new connections can adopt orphaned sessions by referencing the session ID; unclaimed ones are deleted.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { v4 as uuidv4 } from "uuid";
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

/** Bearer token gating inbound MCP connections. Resolved by main() from the
 *  MCP_AUTH_TOKEN env var (highest priority) or config.mcp.authToken. Empty string =
 *  auth disabled (the loopback-dev default). When set, every request to the MCP HTTP
 *  server (3211) must carry `Authorization: Bearer <token>` — this is what makes
 *  binding to a non-loopback host (mcp.host=0.0.0.0, to serve a Parallels/remote VM)
 *  safe despite the proxy having no other access control. */
let authToken = "";

/** Constant-time check of the request's Authorization header against the configured
 *  token. Returns true when auth is disabled (no token configured). */
function isAuthorized(req: IncomingMessage): boolean {
  if (!authToken) return true;
  const header = req.headers["authorization"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const expected = `Bearer ${authToken}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; length is not secret, so guard first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Populated by main() after config is loaded */
let SSE_KEEPALIVE_INTERVAL_MS = 30_000;
let ORPHAN_GRACE_PERIOD_MS = 14_400_000;
/** Enabled provider names, set once by main() before any connections are accepted */
let ENABLED_PROVIDERS: string[] = [];

/** Sessions orphaned by a disconnected MCP connection, awaiting adoption or deletion.
 *  Shared between SSE and Streamable HTTP transports so a session can be re-adopted
 *  across transport types (e.g. Claude Code creates, Codex adopts by sessionId). */
const orphanPool = new Map<string, { timer: NodeJS.Timeout; fromClient: string }>();

/** Active Streamable HTTP transports, keyed by MCP session id (Mcp-Session-Id header) */
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

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

/** Read a JSON request body up to 1MB.
 *  On overflow writes 413 and returns null; on invalid JSON writes 400 and returns null.
 *  Caller must return immediately if null is returned. */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | null> {
  const MAX_BODY = 1_048_576;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
      return null;
    }
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return null;
  }
}

/** Read a raw (non-JSON) request body up to maxBytes, returned as a UTF-8 string.
 *  Byte-accurate counting (not string length) so multi-byte content is bounded correctly.
 *  On overflow writes 413 and returns null; caller must return immediately if null. */
async function readRawBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBytes} bytes)` }));
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
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

/** Stream a proxy chat response back to a raw-HTTP client as a downloadable text body
 *  (for the file-based remote chat endpoints). The body is ALWAYS plain text so
 *  `curl -o reply.txt` captures usable content in every case:
 *    - full reply        -> 200, body = reply, X-Response-Chars
 *    - timeout w/ partial -> 504, body = partial text, X-Partial: true (content not lost)
 *    - other error        -> proxy status, body = error message, X-Error: <code> */
async function writeChatResult(res: ServerResponse, chatRes: Response): Promise<void> {
  if (chatRes.ok) {
    const data = await safeJson<{ response?: string }>(chatRes).catch(() => null);
    const text = data?.response ?? "";
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Response-Chars": String(text.length),
    });
    res.end(text);
    return;
  }
  const body = await safeJson<{ error?: string; message?: string; partialResponse?: string }>(chatRes).catch(() => null);
  if (body?.partialResponse) {
    res.writeHead(504, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Partial": "true",
      "X-Response-Chars": String(body.partialResponse.length),
    });
    res.end(body.partialResponse);
    return;
  }
  res.writeHead(chatRes.status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Error": body?.error ?? "ERROR",
  });
  res.end(body?.message ?? `HTTP ${chatRes.status}`);
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

  // MCP server network + auth: config.json's `mcp` section, with env overrides
  // (MCP_PORT / MCP_HOST / MCP_AUTH_TOKEN) taking priority. The HTTP proxy (3210) is
  // unaffected — it stays on 127.0.0.1 as the internal-only MCP->HTTP hop.
  const rawPort = process.env.MCP_PORT ?? String(config.mcp.port);
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT: ${rawPort}`);
  }
  const host = process.env.MCP_HOST?.trim() || config.mcp.host;
  authToken = process.env.MCP_AUTH_TOKEN?.trim() || config.mcp.authToken.trim();
  const maxMessageBytes = config.maxMessageBytes;
  const transports = new Map<string, SSEServerTransport>();
  let clientSeq = 0;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Bearer-token gate (no-op when no token is configured). Enforced on every
    // request — verified that Claude Code forwards the Authorization header on both
    // the SSE handshake (GET /sse) and follow-up POST /message, as well as on the
    // Streamable HTTP endpoint, so requiring it everywhere does not lock out clients.
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="llm-web-proxy"',
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

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
      const parsed = await readJsonBody(req, res);
      if (parsed === null) return;
      await transport.handlePostMessage(req, res, parsed);
      return;
    }

    // Streamable HTTP transport: single endpoint handling POST/GET/DELETE.
    // Stateful mode — session id is generated on initialize and returned via Mcp-Session-Id header.
    if (url.pathname === "/stream-http") {
      const header = req.headers["mcp-session-id"];
      const mcpSessionId = Array.isArray(header) ? header[0] : header;

      // POST without session id → must be an initialize request; create transport + server.
      if (req.method === "POST" && !mcpSessionId) {
        const parsed = await readJsonBody(req, res);
        if (parsed === null) return;

        const clientId = `[llm-proxy:http-client:${++clientSeq}]`;
        const { server, ownedSessions } = createMcpServer(clientId);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => uuidv4(),
          // Return plain JSON responses instead of SSE-wrapped ones for POST.
          // Rust-based clients (Codex CLI) reject text/event-stream responses on POST.
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            httpTransports.set(sid, transport);
            console.error(`${clientId} connected via stream-http, sid=${sid} (total: ${httpTransports.size})`);
          },
        });

        // NOTE: transport.onclose fires from inside transport.close() (triggered by DELETE,
        // cleanup, or end-of-request). Do NOT call server.close() here — it would re-enter
        // transport.close() via Protocol.close() and recurse until stack overflow.
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) httpTransports.delete(sid);
          for (const s of ownedSessions) orphanSession(s, clientId);
          ownedSessions.clear();
          console.error(`${clientId} disconnected (stream-http, total: ${httpTransports.size})`);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }

      // GET / POST / DELETE with session id → dispatch to the matching transport.
      if (mcpSessionId) {
        const transport = httpTransports.get(mcpSessionId);
        if (!transport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown or expired MCP session" }));
          return;
        }
        let parsed: unknown | undefined;
        if (req.method === "POST") {
          const body = await readJsonBody(req, res);
          if (body === null) return;
          parsed = body;
        }
        await transport.handleRequest(req, res, parsed);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Mcp-Session-Id header" }));
      return;
    }

    // File-based chat (B-direct, for isolated clients with no shared filesystem):
    // request body = the prompt, response body = the reply. Bytes flow disk<->curl<->
    // network and never enter the agent's context. Auth + (for chat-file) an unguessable
    // session id are the access boundary. The prompt is forwarded to the loopback HTTP
    // proxy's chat endpoint; the reply is written back as a plain-text body.

    // One-shot: POST /ask-file?provider=NAME  (auto session create -> chat -> close)
    if (req.method === "POST" && url.pathname === "/ask-file") {
      const provider = url.searchParams.get("provider");
      if (!provider) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing ?provider query parameter" }));
        return;
      }
      const message = await readRawBody(req, res, maxMessageBytes);
      if (message === null) return;
      if (!message.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body (prompt)" }));
        return;
      }

      let sessionId: string;
      try {
        const createRes = await api("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        });
        const created = await safeJson<{ sessionId?: string; message?: string }>(createRes).catch(() => null);
        if (!createRes.ok || !created?.sessionId) {
          res.writeHead(createRes.ok ? 502 : createRes.status, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(created?.message ?? `Failed to create session (HTTP ${createRes.status})`);
          return;
        }
        sessionId = created.sessionId;
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
        return;
      }

      try {
        await writeChatResult(res, await api(`/sessions/${sessionId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err instanceof Error ? err.message : String(err));
        }
      } finally {
        await api(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      }
      return;
    }

    // Multi-turn: POST /sessions/:id/chat-file  (session created via MCP session_create)
    if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/chat-file")) {
      const sessionId = url.pathname.slice("/sessions/".length, -"/chat-file".length);
      if (!sessionId || sessionId.includes("/")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid session id" }));
        return;
      }
      const message = await readRawBody(req, res, maxMessageBytes);
      if (message === null) return;
      if (!message.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body (prompt)" }));
        return;
      }

      try {
        await writeChatResult(res, await api(`/sessions/${sessionId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // Clean up transports and orphan timers on shutdown to allow clean process exit.
  // Closing a stream-http transport fires its onclose, which orphans owned sessions.
  const cleanup = () => {
    for (const t of httpTransports.values()) t.close().catch(() => {});
    httpTransports.clear();
    for (const { timer } of orphanPool.values()) clearTimeout(timer);
    orphanPool.clear();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  httpServer.listen(port, host, () => {
    console.error(`MCP server listening on http://${host}:${port}`);
    console.error(`  legacy SSE:      GET /sse  +  POST /message`);
    console.error(`  Streamable HTTP: /stream-http  (POST/GET/DELETE)`);
    console.error(`  file chat:       POST /ask-file?provider=NAME  |  POST /sessions/:id/chat-file`);
    console.error(`  auth:            ${authToken ? "Bearer token required" : "disabled (loopback dev)"}`);
    if (!isLoopback && !authToken) {
      console.error(
        `  WARNING: bound to non-loopback host ${host} with NO auth — set mcp.authToken (or MCP_AUTH_TOKEN) to avoid LAN exposure`,
      );
    }
  });
}

main();
