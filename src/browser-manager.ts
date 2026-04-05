// Browser lifecycle management: launch/close Chrome, CDP connection, login flow, reconnection
//
// Uses real Chrome (not Playwright's bundled browser) + CDP remote debugging,
// to bypass LLM site automation fingerprint detection. Auth state persists via --user-data-dir.
// Automatically checks auth validity on startup; launches visual login flow when expired.
// Reconnects automatically on browser disconnection, notifying upper layers via reconnectListeners
// (SessionManager uses this to batch-invalidate existing sessions' Page handles).

import { chromium, type Browser, type BrowserContext } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Config } from "./types.js";
import type { AuthChecker } from "./providers/registry.js";

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
  private authChecker: AuthChecker;
  private baseUrl: string;
  /** Callbacks invoked after browser reconnection, used to notify upper layers of session invalidation */
  private reconnectListeners: Array<() => Promise<void>> = [];
  private _authenticated = false;

  constructor(config: Config, authChecker: AuthChecker, baseUrl: string) {
    this.config = config;
    this.authChecker = authChecker;
    this.baseUrl = baseUrl;
  }

  /** Cached auth state, updated by ensureAuth() and invalidateAuth() */
  get authenticated(): boolean {
    return this._authenticated;
  }

  /** Mark auth as invalid, called by SessionManager when AUTH_EXPIRED is detected */
  invalidateAuth(): void {
    this._authenticated = false;
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
   * Launch real Chrome and connect via CDP.
   * Uses real browser instead of Playwright's bundled one to avoid automation fingerprint detection.
   */
  private async launchChrome(headless: boolean): Promise<Browser> {
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
    ];
    if (headless) args.push("--headless=new");

    this.chromeProcess = spawn(chromePath, args, { stdio: "ignore" });

    this.chromeProcess.once("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`Chrome exited with code ${code}`);
      }
    });

    const wsUrl = await this.waitForCDP();

    // Retry CDP connection up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await chromium.connectOverCDP(wsUrl);
      } catch (err) {
        if (attempt === 3) throw err;
        console.warn(`CDP connect attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("unreachable");
  }

  /** Poll until Chrome CDP port is ready, returns the WebSocket debugger URL */
  private async waitForCDP(timeout = 10_000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.config.cdpPort}/json/version`);
        if (res.ok) {
          const json = (await res.json()) as { webSocketDebuggerUrl: string };
          return json.webSocketDebuggerUrl;
        }
      } catch {
        // CDP not ready yet
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

  /** Check if the current browser session is authenticated (delegates to provider's authChecker) */
  async checkAuth(): Promise<boolean> {
    if (!this.context) return false;
    return this.authChecker(this.context, this.config);
  }

  /** Ensure auth is valid; automatically launches interactive login flow when expired */
  async ensureAuth(): Promise<void> {
    if (await this.checkAuth()) {
      this._authenticated = true;
      return;
    }

    this._authenticated = false;
    console.log("Auth expired — launching browser for login...");
    await this.close();
    await this.loginFlow();
    await this.launch();
    this._authenticated = true;
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
        return this.context!;
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
    console.log(`Context initialized for account "${this.config.account.name}"`);
  }

  /**
   * Open a visible Chrome window for manual login.
   * Auth state persists via Chrome --user-data-dir, surviving restarts.
   */
  async loginFlow(): Promise<void> {
    const account = this.config.account;

    const browser = await this.launchChrome(false);
    const context = browser.contexts()[0];
    // Only close Chrome's initial blank/chrome tabs
    for (const p of context.pages()) {
      const url = p.url();
      if (url === "about:blank" || url.startsWith("chrome://newtab")) {
        await p.close().catch(() => {});
      }
    }
    const page = await context.newPage();

    console.log(`\nNavigating to ${this.baseUrl} ...`);
    console.log("Please log in manually. Press Enter in the terminal when done.\n");

    await page.goto(this.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeouts.navigation,
    });

    // Wait for the user to finish manual login and press Enter
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
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
    this.killChrome();
  }

  /** Reconnect after browser disconnection: restart Chrome and notify all listeners */
  private async reconnect(): Promise<void> {
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
      const output = execSync(
        `pgrep -f "remote-debugging-port=${this.config.cdpPort}" 2>/dev/null || true`,
        { encoding: "utf-8" }
      ).trim();
      if (!output) return;

      for (const pidStr of output.split("\n")) {
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;
        try {
          const cmdline = execSync(`ps -p ${pid} -o args= 2>/dev/null`, {
            encoding: "utf-8",
          });
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
