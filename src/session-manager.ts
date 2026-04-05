// Session manager: create/close sessions, send/receive messages, concurrency control,
// session invalidation after browser reconnection
//
// Supports multiple providers: each session is bound to a specific provider at creation time.
// Each session corresponds to an independent provider tab (ProviderPage), serialized by SessionLock
// to handle concurrent requests within the same session (LLM pages cannot handle parallel input).
// SessionLock supports drain() for teardown: rejects all queued requests on session close,
// and waits for the currently executing operation to finish, ensuring no stale operations on page close.
// On browser reconnect, invalidateAll() batch-invalidates all sessions, persists stale state,
// then closes pages; individual session cleanup failures do not block the overall flow.

import { v4 as uuidv4 } from "uuid";
import type { Config, SessionInfo } from "./types.js";
import { BrowserManager } from "./browser-manager.js";
import type { ProviderPageFactory, AuthExpiredDetector } from "./providers/registry.js";
import type { ProviderPage } from "./providers/registry.js";
import { ProxyError, ErrorCode } from "./errors.js";
import { SessionStore } from "./session-store.js";

/** Per-provider runtime dependencies needed to create and manage sessions */
export interface ProviderRuntime {
  pageFactory: ProviderPageFactory;
  authExpiredDetector: AuthExpiredDetector;
  providerUrl: string;
  ephemeral: boolean;
}

/** Internal session structure containing the ProviderPage instance and concurrency lock */
interface InternalSession {
  id: string;
  provider: string;
  accountName: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  providerPage: ProviderPage;
  lock: SessionLock;
  closing: boolean;
  closed: boolean;
  /** Marked when invalidateAll cleanup fails */
  invalidated: boolean;
}

/**
 * Async mutex lock with FIFO queuing and drain() support.
 * drain() rejects all queued waiters, waits for the current holder to release,
 * then enters a terminal state where subsequent acquire() calls fail immediately.
 */
const LOCK_TIMEOUT_MS = 120_000;

class SessionLock {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> =
    [];
  private locked = false;
  private _closed = false;
  private _drainResolve: (() => void) | null = null;

  /** Acquire the lock; throws a deadlock warning on timeout */
  async acquire(timeout = LOCK_TIMEOUT_MS): Promise<void> {
    if (this._closed) {
      throw new Error("Session lock closed");
    }
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const entry: { resolve: () => void; reject: (err: Error) => void } = {
        resolve: () => {
          clearTimeout(timer);
          if (this._closed) {
            reject(new Error("Session lock closed"));
            return;
          }
          resolve();
        },
        reject,
      };

      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error("Session lock timeout — possible deadlock"));
      }, timeout);

      this.queue.push(entry);
    });
  }

  /** Release the lock, waking the next waiter in the queue */
  release(): void {
    if (this._closed) {
      this.locked = false;
      if (this._drainResolve) {
        const cb = this._drainResolve;
        this._drainResolve = null;
        cb();
      }
      return;
    }
    const next = this.queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  /**
   * Teardown: reject all queued waiters and wait for the current holder to release.
   * After completion the lock enters a terminal state; subsequent acquire() calls throw immediately.
   */
  async drain(reason?: Error): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const err = reason ?? new Error("Session closed");
    for (const entry of this.queue) {
      entry.reject(err);
    }
    this.queue = [];

    if (this.locked) {
      // Wait for the current holder to call release()
      return new Promise<void>((resolve) => {
        this._drainResolve = resolve;
      });
    }
    this.locked = false;
  }
}

/** Manages all session lifecycles: create, message send/receive, close, batch invalidation */
export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  /** Number of sessions currently being created, used for capacity calculation */
  private pendingCreates = 0;
  private browserManager: BrowserManager;
  private config: Config;
  private store: SessionStore;
  /** Per-provider runtime dependencies */
  private providerRuntimes: Map<string, ProviderRuntime>;

  constructor(
    config: Config,
    browserManager: BrowserManager,
    providerRuntimes: Map<string, ProviderRuntime>,
  ) {
    this.config = config;
    this.browserManager = browserManager;
    this.providerRuntimes = providerRuntimes;
    this.store = new SessionStore();

    // On browser reconnect, all page handles become invalid; batch-mark sessions as stale
    this.browserManager.onReconnect(async () => {
      console.warn("Browser reconnected — invalidating all existing sessions");
      await this.invalidateAll();
    });
  }

  /** Create a new session for the specified provider: open a new LLM conversation page */
  async createSession(providerName: string): Promise<SessionInfo> {
    const runtime = this.providerRuntimes.get(providerName);
    if (!runtime) {
      throw new ProxyError(
        ErrorCode.BAD_REQUEST,
        `Provider "${providerName}" is not available. Available: ${[...this.providerRuntimes.keys()].join(", ")}`,
      );
    }

    const effectiveCount = this.sessions.size + this.pendingCreates;
    if (effectiveCount >= this.config.maxSessions) {
      throw new ProxyError(
        ErrorCode.CAPACITY_EXHAUSTED,
        `Max sessions reached (${this.config.maxSessions})`
      );
    }

    this.pendingCreates++;
    const accountName = this.config.account.name;

    try {
      // Only serialize page creation (newPage) through the browser queue.
      // Navigation runs outside the queue so multiple sessions can navigate concurrently.
      let providerPage: ProviderPage | undefined;
      try {
        providerPage = await this.browserManager.withBrowserLock(async () => {
          const context = await this.browserManager.getContext();
          const page = await context.newPage();
          return runtime.pageFactory(page, this.config, {
            providerUrl: runtime.providerUrl,
            ephemeral: runtime.ephemeral,
          });
        });
        await providerPage.navigateToNewChat();
      } catch (err: unknown) {
        // Check if auth expired and clean up the created page
        if (providerPage) {
          const url = providerPage.getPageUrl();
          await providerPage.close().catch(() => {});
          if (runtime.authExpiredDetector(url)) {
            this.browserManager.invalidateProviderAuth(providerName);
            throw new ProxyError(
              ErrorCode.AUTH_EXPIRED,
              `Account "${accountName}" login session expired for ${providerName} — re-run login flow`
            );
          }
        }
        if (err instanceof ProxyError) throw err;
        throw new ProxyError(
          ErrorCode.BROWSER_ERROR,
          err instanceof Error ? err.message : String(err)
        );
      }

      const id = uuidv4();
      const now = new Date();

      const session: InternalSession = {
        id,
        provider: providerName,
        accountName,
        createdAt: now,
        lastActivity: now,
        messageCount: 0,
        providerPage: providerPage!,
        lock: new SessionLock(),
        closing: false,
        closed: false,
        invalidated: false,
      };

      this.sessions.set(id, session);
      this.persistSession(session);
      console.log(`Session ${id} created (provider: ${providerName}, account: ${accountName})`);

      return this.toPublicSession(session);
    } finally {
      this.pendingCreates--;
    }
  }

  /** Send a message in the specified session and return the LLM reply */
  async sendMessage(sessionId: string, message: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.throwNotFoundOrClosed(sessionId);

    if (session.closing || session.closed) {
      throw new ProxyError(
        ErrorCode.SESSION_CLOSED,
        `Session "${sessionId}" is closing or already closed`
      );
    }

    // Serialize concurrent requests within the same session
    try {
      await session.lock.acquire();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout")) {
        console.error(`Session ${sessionId} lock timeout — possible deadlock`);
        throw new ProxyError(
          ErrorCode.BROWSER_ERROR,
          `Session "${sessionId}" lock timeout — possible deadlock`
        );
      }
      throw new ProxyError(
        ErrorCode.SESSION_CLOSED,
        `Session "${sessionId}" is closing or already closed`
      );
    }

    try {
      // Re-check after acquiring lock — session may have been closed while queued
      if (session.closing || session.closed) {
        throw new ProxyError(
          ErrorCode.SESSION_CLOSED,
          `Session "${sessionId}" is closing or already closed`
        );
      }

      // Phase 1: browser interaction (serialized through browser queue)
      await this.browserManager.withBrowserLock(() =>
        session.providerPage.submitMessage(message)
      );
      // Phase 2: wait for response (runs outside queue — multiple sessions can poll in parallel)
      const response = await session.providerPage.awaitResponse();
      session.lastActivity = new Date();
      session.messageCount++;
      this.persistSession(session);
      return response;
    } catch (err: unknown) {
      // Session entered closing state during message processing; map to lifecycle error
      if (session.closing || session.closed) {
        if (err instanceof ProxyError) throw err;
        throw new ProxyError(
          ErrorCode.SESSION_CLOSED,
          `Session "${sessionId}" is closing or already closed`
        );
      }
      // Best-effort auth expiry detection
      const runtime = this.providerRuntimes.get(session.provider);
      const url = session.providerPage.getPageUrl();
      if (runtime?.authExpiredDetector(url)) {
        this.browserManager.invalidateProviderAuth(session.provider);
        throw new ProxyError(
          ErrorCode.AUTH_EXPIRED,
          `Account "${session.accountName}" login session expired for ${session.provider} — re-run login flow`
        );
      }
      if (err instanceof ProxyError) throw err;
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ProxyError(ErrorCode.RESPONSE_TIMEOUT, err.message);
      }
      throw new ProxyError(
        ErrorCode.BROWSER_ERROR,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      session.lock.release();
    }
  }

  /** Get a single session's info (includes invalidated stale sessions) */
  getSession(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (session) return this.toPublicSession(session);

    // Fallback: look up invalidated sessions from the persistence store
    const persisted = this.store.getById(sessionId);
    if (persisted?.stale) {
      return {
        id: persisted.id,
        provider: persisted.provider,
        accountName: persisted.accountName,
        createdAt: new Date(persisted.createdAt),
        lastActivity: new Date(persisted.lastActivity),
        messageCount: persisted.messageCount,
        status: "stale",
      };
    }
    return null;
  }

  /** List all sessions (active + stale) */
  listSessions(): SessionInfo[] {
    const live = Array.from(this.sessions.values()).map((s) =>
      this.toPublicSession(s)
    );
    const liveIds = new Set(live.map((s) => s.id));

    // Supplement with stale sessions from persistence store that are not in memory
    const stale: SessionInfo[] = this.store
      .getAll()
      .filter((s) => s.stale && !liveIds.has(s.id))
      .map((s) => ({
        id: s.id,
        provider: s.provider,
        accountName: s.accountName,
        createdAt: new Date(s.createdAt),
        lastActivity: new Date(s.lastActivity),
        messageCount: s.messageCount,
        status: "stale" as const,
      }));

    return [...live, ...stale];
  }

  /** Close the specified session: drain lock queue, close page, clean up store.
   *  Idempotent — closing an already-closed or stale session is a no-op. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Already removed or never existed — treat as success for idempotent DELETE
      if (this.store.getById(sessionId)?.stale) return;
      return this.throwNotFoundOrClosed(sessionId);
    }
    if (session.closed) return;

    // Mark as closing — sendMessage pre-checks will reject requests early
    session.closing = true;

    // Reject all queued waiters and wait for the in-progress operation to complete
    await session.lock.drain(new Error(`Session "${sessionId}" closed`));

    if (!session.closed) {
      await session.providerPage.close();
      session.closed = true;
      this.sessions.delete(sessionId);
      this.store.remove(sessionId);
      console.log(`Session ${sessionId} closed`);
    }
  }

  /**
   * Batch-invalidate all sessions after browser reconnect.
   * Page handles are no longer usable: drain locks, close pages, mark as stale in store.
   */
  async invalidateAll(): Promise<void> {
    // Immediately mark all sessions as closing to block new sendMessage calls
    for (const session of this.sessions.values()) {
      session.closing = true;
    }

    // Drain locks and close pages concurrently to avoid a single slow session blocking the rest
    const entries = Array.from(this.sessions.entries());
    const results = await Promise.allSettled(
      entries.map(async ([id, session]) => {
        await session.lock.drain(
          new Error(`Session "${id}" invalidated — browser reconnected`)
        );
        if (!session.closed) {
          // Persist stale state before closing the page — preserves records even if close() fails
          this.store.save({
            id: session.id,
            provider: session.provider,
            accountName: session.accountName,

            createdAt: session.createdAt.toISOString(),
            lastActivity: session.lastActivity.toISOString(),
            messageCount: session.messageCount,
            stale: true,
          });
          await session.providerPage.close();
          session.closed = true;
        }
      })
    );

    // Only remove successfully invalidated sessions; keep failed ones in memory for diagnostics
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        this.sessions.delete(entries[i][0]);
      } else {
        entries[i][1].invalidated = true;
        console.error(
          `Session ${entries[i][0]} invalidation failed:`,
          (results[i] as PromiseRejectedResult).reason
        );
      }
    }
  }

  /** Close all sessions on process exit and sync-flush to disk */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    const results = await Promise.allSettled(
      ids.map((id) => this.closeSession(id))
    );

    // Clear store if all succeeded; otherwise only remove successfully closed ones
    const allOk = results.every((r) => r.status === "fulfilled");
    if (allOk) {
      this.store.clear();
    } else {
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "fulfilled") {
          this.store.remove(ids[i]);
        }
      }
    }

    this.store.flushSync();
  }

  /** Throw SESSION_CLOSED or SESSION_NOT_FOUND based on whether a stale record exists in the store */
  private throwNotFoundOrClosed(sessionId: string): never {
    const persisted = this.store.getById(sessionId);
    if (persisted?.stale) {
      throw new ProxyError(
        ErrorCode.SESSION_CLOSED,
        `Session "${sessionId}" was invalidated (browser reconnect)`
      );
    }
    throw new ProxyError(
      ErrorCode.SESSION_NOT_FOUND,
      `Session "${sessionId}" not found`
    );
  }

  /** Convert an internal session to the public SessionInfo view */
  private toPublicSession(session: InternalSession): SessionInfo {
    let status: SessionInfo["status"] = "active";
    if (session.invalidated) {
      status = "error";
    } else if (session.closed) {
      status = "stale";
    } else if (session.closing) {
      status = "closing";
    }
    return {
      id: session.id,
      provider: session.provider,
      accountName: session.accountName,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      status,
    };
  }

  /** Persist session metadata to the SessionStore */
  private persistSession(session: InternalSession): void {
    this.store.save({
      id: session.id,
      provider: session.provider,
      accountName: session.accountName,
      createdAt: session.createdAt.toISOString(),
      lastActivity: session.lastActivity.toISOString(),
      messageCount: session.messageCount,
      stale: false,
    });
  }
}
