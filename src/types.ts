// Global type definitions: interfaces for config, sessions, and request/response
//
// Serves as the contract layer between modules; all cross-module data structures are defined here.
// SessionInfo is the public session view, excluding internal details (e.g. Page handles, locks).
// SessionStatus covers the full lifecycle: active -> closing -> stale/error.

export interface AccountConfig {
  name: string;
  /** Backup path for browser storage state */
  storageStatePath: string;
}

/** Per-provider configuration */
export interface ProviderConfig {
  enabled: boolean;
  /** Override the provider's default base URL */
  providerUrl?: string;
  /** Use ephemeral/temporary chat mode (not saved to account history). Default: true */
  ephemeral: boolean;
}

export interface Config {
  /** HTTP proxy (REST API) port — loopback only. The MCP server port is mcp.port. */
  port: number;
  headless: boolean;
  /** Per-provider settings keyed by provider name */
  providers: Record<string, ProviderConfig>;
  maxSessions: number;
  /** Number of blank tabs pre-created at startup to avoid focus stealing on macOS */
  pagePoolSize: number;
  /** Chrome remote debugging port */
  cdpPort: number;
  account: AccountConfig;
  /** Prompt auto-filled after long text is converted to an attachment */
  attachmentPrompt: string;
  /** Max chat message size in bytes. Applies to the HTTP chat schema, the file-based
   *  MCP tools, and the remote chat-file endpoints. Default 1MB. */
  maxMessageBytes: number;
  timeouts: {
    navigation: number;
    /** Base timeout (ms) for waiting for LLM response, before message-size scaling */
    responseBase: number;
    /** Additional timeout (ms) per KB of input message; scales with message size */
    responsePerKB: number;
    /** Wait time to confirm response text has stabilized (stopped changing) */
    stability: number;
  };
  /** SSE keepalive interval in seconds, prevents idle timeout disconnects */
  sseKeepaliveSec: number;
  /** Grace period in seconds for orphaned sessions after SSE disconnect; deleted if unclaimed */
  orphanGraceSec: number;
  /** MCP server (3211) network + access control. Env vars override these at startup:
   *  MCP_HOST > mcp.host, MCP_PORT > mcp.port, MCP_AUTH_TOKEN > mcp.authToken. */
  mcp: {
    /** Bind host. Default "127.0.0.1" (loopback). Set "0.0.0.0" to serve a remote/VM client. */
    host: string;
    /** MCP server port. */
    port: number;
    /** Bearer token required on every MCP request. Empty string disables auth (loopback dev). */
    authToken: string;
  };
}

export type SessionStatus = "active" | "closing" | "stale" | "error";

export interface SessionInfo {
  id: string;
  provider: string;
  accountName: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  status: SessionStatus;
}

export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  response: string;
  durationMs: number;
}

export interface ErrorResponse {
  error: string;
  message: string;
}
