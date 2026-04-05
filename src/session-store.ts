// 会话持久化存储：将会话元数据异步写入 JSON 文件，支持优雅关闭时同步刷盘
//
// 内存 Map 为权威数据源，磁盘文件为快照。写盘采用去抖合并（200ms）减少 I/O，
// 写入时先写 .tmp 再原子 rename，防止写到一半崩溃导致数据损坏。
// 进程退出时 flushSync() 同步刷盘确保数据不丢。
// 进程重启后加载的会话统一标记为 stale（Page 句柄已失效），供 API 层查询历史。

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

/** 持久化到磁盘的会话数据结构 */
export interface PersistedSession {
  id: string;
  accountName: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  /** 进程重启后原有会话的 Page 句柄已失效，标记为 stale */
  stale: boolean;
}

const STORE_PATH = resolve("./.chatgpt-proxy/sessions.json");
/** 写入去抖间隔，合并高频写操作为单次 I/O */
const DEBOUNCE_MS = 200;

/** 会话持久化存储，内存 Map 为权威数据源，异步去抖写盘 */
export class SessionStore {
  private sessions = new Map<string, PersistedSession>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor() {
    this.load();
  }

  /** 从磁盘加载会话，所有加载的会话标记为 stale（Page 句柄已失效） */
  private load(): void {
    if (!existsSync(STORE_PATH)) return;

    try {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const data = JSON.parse(raw) as { sessions: PersistedSession[] };
      // 进程重启后 Page 句柄丢失，统一标记为 stale
      for (const session of data.sessions) {
        session.stale = true;
        this.sessions.set(session.id, session);
      }
      // 立即将 stale 状态写盘，确保文件反映真实状态
      if (this.sessions.size > 0) {
        this.scheduleFlush();
      }
    } catch {
      console.warn("Failed to load session store, starting fresh");
    }
  }

  /** 序列化为 JSON 字符串 */
  private toSerializable(): string {
    const data = {
      sessions: Array.from(this.sessions.values()),
      savedAt: new Date().toISOString(),
    };
    return JSON.stringify(data, null, 2);
  }

  /** 调度一次去抖写盘，合并短时间内的多次变更为单次 I/O */
  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPromise = this.flushAsync().finally(() => {
        this.flushPromise = null;
        // 刷盘期间若有新写入，再调度一次
        if (this.dirty) this.scheduleFlush();
      });
    }, DEBOUNCE_MS);
  }

  /** 异步写盘：先写临时文件再原子重命名，避免写到一半崩溃导致数据损坏 */
  private async flushAsync(): Promise<void> {
    this.dirty = false;
    const dir = dirname(STORE_PATH);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmpPath = STORE_PATH + ".tmp";
    await writeFile(tmpPath, this.toSerializable());
    await rename(tmpPath, STORE_PATH);
  }

  /**
   * 同步写盘 — 仅在进程关闭时使用，确保数据在退出前落盘。
   * 无条件写入，覆盖可能正在进行的异步刷盘。
   */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.flushPromise = null;
    const dir = dirname(STORE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = STORE_PATH + ".tmp";
    writeFileSync(tmpPath, this.toSerializable());
    renameSync(tmpPath, STORE_PATH);
  }

  /** 保存或更新一条会话记录 */
  save(session: PersistedSession): void {
    this.sessions.set(session.id, session);
    this.scheduleFlush();
  }

  /** 删除一条会话记录 */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.scheduleFlush();
  }

  getById(sessionId: string): PersistedSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): PersistedSession[] {
    return Array.from(this.sessions.values());
  }

  /** 清空所有会话记录 */
  clear(): void {
    this.sessions.clear();
    this.scheduleFlush();
  }
}
