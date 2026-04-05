// 会话管理器：创建/关闭会话、消息收发、并发控制、浏览器重连后会话失效处理
//
// 每个会话对应一个独立的 ChatGPT 标签页（ChatGPTPage），由 SessionLock 串行化
// 同一会话的并发请求（ChatGPT 页面无法处理并行输入）。
// SessionLock 支持 drain() 终止操作：关闭会话时拒绝所有排队请求，
// 并等待当前执行中的操作完成，确保页面关闭时无残留操作。
// 浏览器重连时 invalidateAll() 批量失效所有会话，持久化 stale 状态后关闭页面，
// 即使单个会话清理失败也不阻塞整体流程。

import { v4 as uuidv4 } from "uuid";
import type { Config, SessionInfo } from "./types.js";
import { BrowserManager } from "./browser-manager.js";
import type { ProviderPage, ProviderPageFactory, AuthExpiredDetector } from "./providers/registry.js";
import { ProxyError, ErrorCode } from "./errors.js";
import { SessionStore } from "./session-store.js";

/** 内部会话结构，包含 ProviderPage 实例和并发锁 */
interface InternalSession {
  id: string;
  accountName: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  providerPage: ProviderPage;
  lock: SessionLock;
  closing: boolean;
  closed: boolean;
  /** invalidateAll 清理失败时标记 */
  invalidated: boolean;
}

/**
 * 异步互斥锁，FIFO 排队，支持 drain() 终止操作。
 * drain() 拒绝所有排队者，等待当前持有者释放后进入终态，后续 acquire() 立即失败。
 */
const LOCK_TIMEOUT_MS = 120_000;

class SessionLock {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> =
    [];
  private locked = false;
  private _closed = false;
  private _drainResolve: (() => void) | null = null;

  /** 获取锁，超时后抛出死锁警告 */
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

  /** 释放锁，唤醒队列中下一个等待者 */
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
   * 终止操作：拒绝所有排队者，等待当前持有者释放。
   * 完成后锁进入终态，后续 acquire() 均立即抛异常。
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
      // 等待当前持有者调用 release()
      return new Promise<void>((resolve) => {
        this._drainResolve = resolve;
      });
    }
    this.locked = false;
  }
}

/** 管理所有会话的生命周期：创建、消息收发、关闭、批量失效 */
export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  /** 正在创建中的会话数，用于容量计算 */
  private pendingCreates = 0;
  private browserManager: BrowserManager;
  private config: Config;
  private store: SessionStore;
  private pageFactory: ProviderPageFactory;
  private authExpiredDetector: AuthExpiredDetector;

  constructor(
    config: Config,
    browserManager: BrowserManager,
    pageFactory: ProviderPageFactory,
    authExpiredDetector: AuthExpiredDetector,
  ) {
    this.config = config;
    this.browserManager = browserManager;
    this.pageFactory = pageFactory;
    this.authExpiredDetector = authExpiredDetector;
    this.store = new SessionStore();

    // 浏览器重连时所有页面句柄失效，批量标记会话为 stale
    this.browserManager.onReconnect(async () => {
      console.warn("Browser reconnected — invalidating all existing sessions");
      await this.invalidateAll();
    });
  }

  /** 创建新会话：打开 ChatGPT 新对话页面 */
  async createSession(): Promise<SessionInfo> {
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
      let providerPage: ProviderPage | undefined;
      try {
        const context = await this.browserManager.getContext();
        const page = await context.newPage();
        providerPage = this.pageFactory(page, this.config);
        await providerPage.navigateToNewChat();
      } catch (err: unknown) {
        // 检测是否为认证过期并清理已创建的页面
        if (providerPage) {
          const url = providerPage.getPageUrl();
          await providerPage.close();
          if (this.authExpiredDetector(url)) {
            this.browserManager.invalidateAuth();
            throw new ProxyError(
              ErrorCode.AUTH_EXPIRED,
              `Account "${accountName}" login session expired — re-run login flow`
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
        accountName,
        createdAt: now,
        lastActivity: now,
        messageCount: 0,
        providerPage,
        lock: new SessionLock(),
        closing: false,
        closed: false,
        invalidated: false,
      };

      this.sessions.set(id, session);
      this.persistSession(session);
      console.log(`Session ${id} created (account: ${accountName})`);

      return this.toPublicSession(session);
    } finally {
      this.pendingCreates--;
    }
  }

  /** 在指定会话中发送消息并返回 ChatGPT 回复 */
  async sendMessage(sessionId: string, message: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.throwNotFoundOrClosed(sessionId);
    }

    if (session.closing || session.closed) {
      throw new ProxyError(
        ErrorCode.SESSION_CLOSED,
        `Session "${sessionId}" is closing or already closed`
      );
    }

    // 串行化同一会话的并发请求
    try {
      await session.lock.acquire();
    } catch {
      // 等待期间会话被关闭/drain
      throw new ProxyError(
        ErrorCode.SESSION_CLOSED,
        `Session "${sessionId}" is closing or already closed`
      );
    }

    try {
      // 获取锁后再次检查 — 排队期间会话可能已关闭
      if (session.closing || session.closed) {
        throw new ProxyError(
          ErrorCode.SESSION_CLOSED,
          `Session "${sessionId}" is closing or already closed`
        );
      }

      const response = await session.providerPage.sendMessage(message);
      session.lastActivity = new Date();
      session.messageCount++;
      this.persistSession(session);
      return response;
    } catch (err: unknown) {
      // 消息处理过程中会话进入关闭状态，映射为生命周期错误
      if (session.closing || session.closed) {
        if (err instanceof ProxyError) throw err;
        throw new ProxyError(
          ErrorCode.SESSION_CLOSED,
          `Session "${sessionId}" is closing or already closed`
        );
      }
      // 尽力检测认证过期
      const url = session.providerPage.getPageUrl();
      if (this.authExpiredDetector(url)) {
        this.browserManager.invalidateAuth();
        throw new ProxyError(
          ErrorCode.AUTH_EXPIRED,
          `Account "${session.accountName}" login session expired — re-run login flow`
        );
      }
      if (err instanceof ProxyError) throw err;
      throw new ProxyError(
        ErrorCode.BROWSER_ERROR,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      session.lock.release();
    }
  }

  /** 获取单个会话信息（含已失效的 stale 会话） */
  getSession(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (session) return this.toPublicSession(session);

    // 回退：从持久化存储中查找已失效的会话
    const persisted = this.store.getById(sessionId);
    if (persisted?.stale) {
      return {
        id: persisted.id,
        accountName: persisted.accountName,
        createdAt: new Date(persisted.createdAt),
        lastActivity: new Date(persisted.lastActivity),
        messageCount: persisted.messageCount,
        status: "stale",
      };
    }
    return null;
  }

  /** 列出所有会话（活跃 + stale） */
  listSessions(): SessionInfo[] {
    const live = Array.from(this.sessions.values()).map((s) =>
      this.toPublicSession(s)
    );
    const liveIds = new Set(live.map((s) => s.id));

    // 补充持久化存储中不在内存里的 stale 会话
    const stale: SessionInfo[] = this.store
      .getAll()
      .filter((s) => s.stale && !liveIds.has(s.id))
      .map((s) => ({
        id: s.id,
        accountName: s.accountName,
        createdAt: new Date(s.createdAt),
        lastActivity: new Date(s.lastActivity),
        messageCount: s.messageCount,
        status: "stale" as const,
      }));

    return [...live, ...stale];
  }

  /** 关闭指定会话：排空锁队列、关闭页面、清理存储 */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.throwNotFoundOrClosed(sessionId);
    }

    // 标记为正在关闭 — sendMessage 的前置检查会提前拒绝请求
    session.closing = true;

    // 拒绝所有排队者并等待正在执行的操作完成
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
   * 浏览器重连后批量失效所有会话。
   * 页面句柄已不可用：排空锁、关闭页面、在存储中标记为 stale。
   */
  async invalidateAll(): Promise<void> {
    // 立即标记所有会话为 closing，阻止新的 sendMessage
    for (const session of this.sessions.values()) {
      session.closing = true;
    }

    // 并发排空锁和关闭页面，避免单个慢会话阻塞整体
    const entries = Array.from(this.sessions.entries());
    const results = await Promise.allSettled(
      entries.map(async ([id, session]) => {
        await session.lock.drain(
          new Error(`Session "${id}" invalidated — browser reconnected`)
        );
        if (!session.closed) {
          // 先持久化 stale 状态再关闭页面 — 即使 close() 失败也能保留记录
          this.store.save({
            id: session.id,
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

    // 仅移除成功失效的会话；失败的保留在内存中便于诊断
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

  /** 进程退出时关闭所有会话并同步刷盘 */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    const results = await Promise.allSettled(
      ids.map((id) => this.closeSession(id))
    );

    // 全部成功则清空存储，否则只删除成功关闭的
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

  /** 根据 store 中是否存在 stale 记录，抛出 SESSION_CLOSED 或 SESSION_NOT_FOUND */
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

  /** 将内部会话转为公开的 SessionInfo */
  private toPublicSession(session: InternalSession): SessionInfo {
    let status: SessionInfo["status"] = "active";
    if (session.invalidated) {
      status = "error";
    } else if (session.closing) {
      status = "closing";
    }
    return {
      id: session.id,
      accountName: session.accountName,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      status,
    };
  }

  /** 将会话元数据持久化到 SessionStore */
  private persistSession(session: InternalSession): void {
    this.store.save({
      id: session.id,
      accountName: session.accountName,
      createdAt: session.createdAt.toISOString(),
      lastActivity: session.lastActivity.toISOString(),
      messageCount: session.messageCount,
      stale: false,
    });
  }
}
