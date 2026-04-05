// Session persistence store: async writes session metadata to a JSON file, with sync flush on shutdown
//
// In-memory Map is the authoritative data source; disk file is a snapshot.
// Writes use debounced coalescing (200ms) to reduce I/O.
// Writes go to a .tmp file first, then atomic rename, to prevent corruption from mid-write crashes.
// flushSync() on process exit ensures data is persisted before shutdown.
// Sessions loaded after restart are marked as stale (Page handles are no longer valid) for API history queries.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

/** Session data structure persisted to disk */
export interface PersistedSession {
  id: string;
  accountName: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  /** After process restart, Page handles from prior sessions are invalid; marked as stale */
  stale: boolean;
}

const STORE_PATH = resolve("./.llm-web-proxy/sessions.json");
/** Debounce interval for write coalescing, merging frequent writes into a single I/O */
const DEBOUNCE_MS = 200;

/** Session persistence store; in-memory Map is authoritative, with async debounced disk writes */
export class SessionStore {
  private sessions = new Map<string, PersistedSession>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor() {
    this.load();
  }

  /** Load sessions from disk; all loaded sessions are marked stale (Page handles are invalid) */
  private load(): void {
    if (!existsSync(STORE_PATH)) return;

    try {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const data = JSON.parse(raw) as { sessions: PersistedSession[] };
      // Page handles are lost after restart; mark all as stale
      for (const session of data.sessions) {
        session.stale = true;
        this.sessions.set(session.id, session);
      }
      // Write stale status to disk immediately to reflect true state
      if (this.sessions.size > 0) {
        this.scheduleFlush();
      }
    } catch {
      console.warn("Failed to load session store, starting fresh");
    }
  }

  /** Serialize to JSON string */
  private toSerializable(): string {
    const data = {
      sessions: Array.from(this.sessions.values()),
      savedAt: new Date().toISOString(),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Schedule a debounced disk write, coalescing multiple changes into a single I/O */
  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPromise = this.flushAsync().finally(() => {
        this.flushPromise = null;
        // If new writes arrived during flush, schedule another
        if (this.dirty) this.scheduleFlush();
      });
    }, DEBOUNCE_MS);
  }

  /** Async disk write: write to temp file then atomic rename to prevent corruption */
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
   * Sync disk write — used only during process shutdown to ensure data is persisted before exit.
   * Writes unconditionally, overriding any in-progress async flush.
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

  /** Save or update a session record */
  save(session: PersistedSession): void {
    this.sessions.set(session.id, session);
    this.scheduleFlush();
  }

  /** Remove a session record */
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

  /** Clear all session records */
  clear(): void {
    this.sessions.clear();
    this.scheduleFlush();
  }
}
