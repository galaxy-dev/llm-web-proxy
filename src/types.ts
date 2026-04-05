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
}

export interface Config {
  port: number;
  headless: boolean;
  /** Per-provider settings keyed by provider name */
  providers: Record<string, ProviderConfig>;
  maxSessions: number;
  /** Chrome remote debugging port */
  cdpPort: number;
  account: AccountConfig;
  /** Prompt auto-filled after long text is converted to an attachment */
  attachmentPrompt: string;
  timeouts: {
    navigation: number;
    /** Timeout for waiting for LLM response */
    response: number;
    /** Wait time to confirm response text has stabilized (stopped changing) */
    stability: number;
  };
  /** SSE keepalive interval in seconds, prevents idle timeout disconnects */
  sseKeepaliveSec: number;
  /** Grace period in seconds for orphaned sessions after SSE disconnect; deleted if unclaimed */
  orphanGraceSec: number;
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
