// Browser lifecycle management: launch/close Chrome, CDP connection, login flow, reconnection
//
// Uses real Chrome (not Playwright's bundled browser) + CDP remote debugging,
// to bypass LLM site automation fingerprint detection. Auth state persists via --user-data-dir.
// Supports multi-provider auth: tracks per-provider authentication status,
// and provides parallel login flow (one tab per provider).
// Reconnects automatically on browser disconnection, notifying upper layers via reconnectListeners
// (SessionManager uses this to batch-invalidate existing sessions' Page handles).

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { Config } from "./types.js";
import type { AuthChecker } from "./providers/registry.js";
import { OperationQueue } from "./operation-queue.js";

/** Common Chrome executable paths */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

/** Manages the full lifecycle of a Chrome browser instance: launch, connect, auth, reconnect, close */
export class BrowserManager {
  private browser: Browser | null = null;
  private chromeProcess: ChildProcess | null = null;
  private context: BrowserContext | null = null;
  private config: Config;
  /** Callbacks invoked after browser reconnection, used to notify upper layers of session invalidation */
  private reconnectListeners: Array<() => Promise<void>> = [];
  /** Deduplicates concurrent reconnect() calls — second caller awaits the same promise */
  private reconnectPromise: Promise<void> | null = null;
  /** Serializes browser-interactive operations (page creation, paste, send) to prevent resource contention */
  private browserQueue = new OperationQueue();
  /** Pre-created blank pages to avoid focus-stealing newPage() during operation */
  private pagePool: Page[] = [];
  /** Per-provider authentication status */
  private authStatuses = new Map<string, boolean>();

  constructor(config: Config) {
    this.config = config;
  }

  /** Get cached auth state for a specific provider */
  isProviderAuthenticated(providerName: string): boolean {
    return this.authStatuses.get(providerName) ?? false;
  }

  /** Mark a provider's auth as invalid, called by SessionManager when AUTH_EXPIRED is detected */
  invalidateProviderAuth(providerName: string): void {
    this.authStatuses.set(providerName, false);
  }

  /** Check auth for a specific provider using its auth checker; updates cached status */
  async checkProviderAuth(
    providerName: string,
    authChecker: AuthChecker,
    providerUrl: string,
  ): Promise<boolean> {
    if (!this.context) return false;
    const result = await authChecker(this.context, this.config, providerUrl);
    this.authStatuses.set(providerName, result);
    return result;
  }

  /** Chrome user data directory, isolated by account name */
  private get profileDir(): string {
    return resolve(`./.llm-web-proxy/chrome-profiles/${this.config.account.name}`);
  }

  /** Register a callback for browser reconnection events (e.g. session invalidation) */
  onReconnect(cb: () => Promise<void>): void {
    this.reconnectListeners.push(cb);
  }

  /** Find the Chrome executable path, preferring the CHROME_PATH env variable */
  private findChrome(): string {
    const envPath = process.env.CHROME_PATH;
    if (envPath) {
      if (!existsSync(envPath)) throw new Error(`CHROME_PATH not found: ${envPath}`);
      return envPath;
    }
    for (const p of CHROME_CANDIDATES) {
      if (existsSync(p)) return p;
    }
    throw new Error(
      "Chrome not found. Install Google Chrome or set CHROME_PATH env variable."
    );
  }

  /**
   * Launch real Chrome and connect via CDP, returning browser + child process.
   * Does NOT write to instance fields — caller decides whether to store the process.
   */
  private async launchChromeDetached(headless: boolean): Promise<{ browser: Browser; process: ChildProcess }> {
    // Clean up Chrome processes that may have survived a previous crash
    this.killChrome();
    this.killChromeOnPort();

    const chromePath = this.findChrome();
    const profileDir = this.profileDir;
    if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

    // Remove stale profile lock files
    const lockFile = resolve(profileDir, "SingletonLock");
    if (existsSync(lockFile)) rmSync(lockFile, { force: true });

    const args = [
      `--remote-debugging-port=${this.config.cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-crash-restore-bubble",
      "--noerrdialogs",
    ];
    if (headless) args.push("--headless=new");

    const chromeProc = spawn(chromePath, args, { stdio: "ignore" });

    chromeProc.once("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`Chrome exited with code ${code}`);
      }
    });

    const wsUrl = await this.waitForCDP(chromeProc);

    // Retry CDP connection up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const browser = await chromium.connectOverCDP(wsUrl);
        return { browser, process: chromeProc };
      } catch (err) {
        if (attempt === 3) throw err;
        console.warn(`CDP connect attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("unreachable");
  }

  /** Launch Chrome and store the process reference in instance fields */
  private async launchChrome(headless: boolean): Promise<Browser> {
    const result = await this.launchChromeDetached(headless);
    this.chromeProcess = result.process;
    return result.browser;
  }

  /** Poll until Chrome CDP port is ready, returns the WebSocket debugger URL.
   *  @param chromeProc The spawned Chrome process to monitor for early exit */
  private async waitForCDP(chromeProc: ChildProcess, timeout = 10_000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // Fail fast if Chrome already exited
      if (chromeProc.exitCode != null) {
        throw new Error(`Chrome exited prematurely with code ${chromeProc.exitCode}`);
      }
      try {
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://127.0.0.1:${this.config.cdpPort}/json/version`, {
          signal: controller.signal,
        });
        clearTimeout(fetchTimer);
        if (res.ok) {
          const json = (await res.json()) as { webSocketDebuggerUrl: string };
          return json.webSocketDebuggerUrl;
        }
      } catch {
        // CDP not ready yet or fetch timed out
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Chrome CDP not ready after ${timeout}ms`);
  }

  /** Launch Chrome and initialize the browser context */
  async launch(): Promise<void> {
    this.browser = await this.launchChrome(this.config.headless);
    await this.initContext();
    console.log(`Chrome launched via CDP (headless: ${this.config.headless})`);
  }

  /** Serialize a browser-interactive operation through the queue.
   *  Only browser-touching work (page creation, navigation, text input, send button click)
   *  should go through this queue. Response-waiting phases should run outside it. */
  withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.browserQueue.enqueue(fn);
  }

  /** Get a page from the pre-created pool, or create a new one as fallback.
   *  Pool pages are created at startup when Chrome already has focus,
   *  avoiding focus-stealing newPage() calls during normal operation. */
  async newPage(): Promise<Page> {
    const pooled = this.pagePool.pop();
    if (pooled) return pooled;
    // Pool exhausted — fall back to direct creation
    const context = await this.getContext();
    return context.newPage();
  }

  /** Return a page to the pool for reuse. Navigates to about:blank to clear state.
   *  If the page is broken (e.g. after browser reconnect), silently closes it instead. */
  async recyclePage(page: Page): Promise<void> {
    try {
      await page.goto("about:blank", { timeout: 5000 });
      this.pagePool.push(page);
    } catch {
      await page.close().catch(() => {});
    }
  }

  /** Get the shared browser context (auto-reconnects on disconnect) */
  async getContext(): Promise<BrowserContext> {
    if (this.context) {
      try {
        this.context.pages();
        return this.context;
      } catch {
        console.warn("Browser context lost, reconnecting...");
        this.context = null;
        await this.reconnect();
        if (!this.context) throw new Error("Reconnect succeeded but context is null");
        return this.context;
      }
    }
    throw new Error("Browser not launched or context not initialized");
  }

  /** Initialize browser context: get default context and close Chrome's built-in blank tabs */
  private async initContext(): Promise<void> {
    if (!this.browser) throw new Error("Browser not launched");

    const context = this.browser.contexts()[0];
    if (!context) {
      throw new Error("No browser context available from CDP connection");
    }

    // Close blank pages that Chrome opens automatically on startup
    for (const p of context.pages()) {
      const url = p.url();
      if (url === "about:blank" || url.startsWith("chrome://newtab")) {
        await p.close().catch(() => {});
      }
    }

    this.context = context;

    // Pre-create blank pages so that session creation can use pooled pages
    // instead of calling context.newPage() which steals focus on macOS.
    // Created here (during startup) when Chrome already has focus — no user impact.
    this.pagePool = [];
    const poolSize = Math.min(this.config.maxSessions, this.config.pagePoolSize);
    for (let i = 0; i < poolSize; i++) {
      this.pagePool.push(await context.newPage());
    }

    console.log(`Context initialized for account "${this.config.account.name}" (${poolSize} pages pooled)`);
  }

  /**
   * Open a visible Chrome window for manual login across multiple providers.
   * Opens one tab per provider; user logs in to all, then presses Enter.
   * Auth state persists via Chrome --user-data-dir, surviving restarts.
   */
  async loginFlowMulti(
    providers: Array<{ name: string; baseUrl: string }>,
  ): Promise<void> {
    const account = this.config.account;

    // Use launchChromeDetached to avoid writing to this.chromeProcess,
    // keeping the login browser fully isolated from the service browser lifecycle.
    const { browser, process: chromeProc } = await this.launchChromeDetached(false);
    try {
      const context = browser.contexts()[0];
      // Close Chrome's initial blank/chrome tabs
      for (const p of context.pages()) {
        const url = p.url();
        if (url === "about:blank" || url.startsWith("chrome://newtab")) {
          await p.close().catch(() => {});
        }
      }

      // Open one tab per provider, navigating in parallel
      console.log(`\nOpening login pages for: ${providers.map((p) => p.name).join(", ")}`);
      await Promise.all(
        providers.map(async (prov) => {
          const page = await context.newPage();
          console.log(`  ${prov.name}: ${prov.baseUrl}`);
          await page.goto(prov.baseUrl, {
            waitUntil: "domcontentloaded",
            timeout: this.config.timeouts.navigation,
          });
        }),
      );

      console.log("\nPlease log in to all providers. Press Enter in the terminal when done.\n");

      // Wait for the user to finish manual login and press Enter
      await new Promise<void>((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", () => {
          process.stdin.pause();
          resolve();
        });
      });

      // Save storage state as a backup snapshot
      const storagePath = resolve(account.storageStatePath);
      const dir = dirname(storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      await context.storageState({ path: storagePath });
      console.log(`Storage state saved to ${storagePath}`);

      await browser.close();
    } finally {
      // Ensure Chrome process is cleaned up even if login flow throws
      if (chromeProc.exitCode == null) {
        chromeProc.kill();
        await new Promise<void>((r) => chromeProc.once("exit", r));
      }
    }
  }

  /** Reconnect after browser disconnection: restart Chrome and notify all listeners.
   *  Deduplicates concurrent calls — if a reconnect is already in progress, callers share the same promise. */
  private reconnect(): Promise<void> {
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = this.doReconnect().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private async doReconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.context = null;
    this.killChrome();
    this.browser = await this.launchChrome(this.config.headless);
    await this.initContext();
    console.log("Chrome reconnected");

    // Notify listeners — old page handles are now invalid
    for (const listener of this.reconnectListeners) {
      await listener().catch((err: unknown) => {
        console.error("onReconnect listener failed:", err);
      });
    }
  }


  /** Close the browser and Chrome process */
  async close(): Promise<void> {
    // Default context is a browser-level shared resource, cannot be closed individually
    this.context = null;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    // Gracefully wait for Chrome to exit, force-kill on timeout
    await this.stopChrome();
    console.log("Browser closed");
  }

  /** Gracefully close Chrome: wait for natural exit first, SIGKILL on timeout */
  private async stopChrome(timeout = 5000): Promise<void> {
    if (!this.chromeProcess) return;
    const proc = this.chromeProcess;
    this.chromeProcess = null;

    if (proc.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, timeout);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Kill the tracked Chrome child process */
  private killChrome(): void {
    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
  }

  /** Kill stale Chrome processes occupying this instance's CDP port with the same profile */
  private killChromeOnPort(): void {
    // Match CDP port + profile dir precisely to avoid killing the user's own Chrome
    const profileDir = this.profileDir;
    try {
      const output = execFileSync(
        "pgrep",
        ["-f", `remote-debugging-port=${this.config.cdpPort}`],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (!output) return;

      for (const pidStr of output.split("\n")) {
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;
        try {
          const cmdline = execFileSync(
            "ps",
            ["-p", String(pid), "-o", "args="],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
          );
          if (cmdline.includes(profileDir)) {
            process.kill(pid, "SIGTERM");
          }
        } catch {
          // Process already exited
        }
      }
    } catch {
      // pgrep unavailable or no matches — normal
    }
  }
}
