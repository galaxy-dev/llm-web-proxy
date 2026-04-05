// 浏览器生命周期管理：启动/关闭 Chrome、CDP 连接、登录流程、断线重连
//
// 使用真实 Chrome（非 Playwright 内置浏览器）+ CDP 远程调试连接，
// 规避 ChatGPT 的自动化指纹检测。认证状态通过 --user-data-dir 持久化。
// 启动时自动检测认证有效性，过期则启动可视化登录流程。
// 运行中浏览器断线会自动重连，并通过 reconnectListeners 通知上层
// （SessionManager 据此批量失效已有会话的 Page 句柄）。

import { chromium, type Browser, type BrowserContext } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Config } from "./types.js";
import type { AuthChecker } from "./providers/registry.js";

/** Chrome 可执行文件的常见路径 */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

/** 管理 Chrome 浏览器实例的完整生命周期：启动、连接、认证、重连、关闭 */
export class BrowserManager {
  private browser: Browser | null = null;
  private chromeProcess: ChildProcess | null = null;
  private context: BrowserContext | null = null;
  private config: Config;
  private authChecker: AuthChecker;
  private baseUrl: string;
  /** 浏览器重连后的回调列表，用于通知上层会话失效 */
  private reconnectListeners: Array<() => Promise<void>> = [];
  private _authenticated = false;

  constructor(config: Config, authChecker: AuthChecker, baseUrl: string) {
    this.config = config;
    this.authChecker = authChecker;
    this.baseUrl = baseUrl;
  }

  /** 缓存的认证状态，由 ensureAuth() 和 invalidateAuth() 更新 */
  get authenticated(): boolean {
    return this._authenticated;
  }

  /** 标记认证已失效，由 SessionManager 在检测到 AUTH_EXPIRED 时调用 */
  invalidateAuth(): void {
    this._authenticated = false;
  }

  /** Chrome 用户数据目录，按账号名隔离 */
  private get profileDir(): string {
    return resolve(`./.chatgpt-proxy/chrome-profiles/${this.config.account.name}`);
  }

  /** 注册浏览器重连后的回调（如会话失效处理） */
  onReconnect(cb: () => Promise<void>): void {
    this.reconnectListeners.push(cb);
  }

  /** 查找 Chrome 可执行文件路径，优先使用 CHROME_PATH 环境变量 */
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
   * 启动真实 Chrome 并通过 CDP 连接。
   * 使用真实浏览器而非 Playwright 内置浏览器，避免自动化指纹检测。
   */
  private async launchChrome(headless: boolean): Promise<Browser> {
    // 清理上次崩溃可能残留的 Chrome 进程
    this.killChrome();
    this.killChromeOnPort();

    const chromePath = this.findChrome();
    const profileDir = this.profileDir;
    if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

    // 清除残留的 profile 锁文件
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

    // CDP 连接最多重试 3 次
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

  /** 轮询等待 Chrome CDP 端口就绪，返回 WebSocket 调试地址 */
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
        // CDP 尚未就绪
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Chrome CDP not ready after ${timeout}ms`);
  }

  /** 启动 Chrome 并初始化浏览器上下文 */
  async launch(): Promise<void> {
    this.browser = await this.launchChrome(this.config.headless);
    await this.initContext();
    console.log(`Chrome launched via CDP (headless: ${this.config.headless})`);
  }

  /** 检查当前浏览器会话是否已通过认证（委托给 provider 的 authChecker） */
  async checkAuth(): Promise<boolean> {
    if (!this.context) return false;
    return this.authChecker(this.context, this.config);
  }

  /** 确保认证有效，过期时自动启动交互式登录流程 */
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

  /** 获取共享的浏览器上下文（连接断开时自动重连） */
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

  /** 初始化浏览器上下文：获取默认上下文并清理 Chrome 自带的空白标签页 */
  private async initContext(): Promise<void> {
    if (!this.browser) throw new Error("Browser not launched");

    const context = this.browser.contexts()[0];
    if (!context) {
      throw new Error("No browser context available from CDP connection");
    }

    // 关闭 Chrome 启动时自动打开的空白页
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
   * 打开可视 Chrome 窗口进行手动登录。
   * 认证状态通过 Chrome --user-data-dir 持久化，跨重启保留。
   */
  async loginFlow(): Promise<void> {
    const account = this.config.account;

    const browser = await this.launchChrome(false);
    const context = browser.contexts()[0];
    // 仅关闭 Chrome 初始的空白/chrome 标签页
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

    // 等待用户手动登录后按回车
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });

    // 保存存储状态作为备份快照
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

  /** 浏览器断线重连：重启 Chrome 并通知所有监听者 */
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

    // 通知监听者 — 旧的页面句柄已失效
    for (const listener of this.reconnectListeners) {
      await listener().catch((err: unknown) => {
        console.error("onReconnect listener failed:", err);
      });
    }
  }

  /** 关闭浏览器和 Chrome 进程 */
  async close(): Promise<void> {
    // 默认上下文是浏览器级共享资源，不能单独关闭
    this.context = null;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    // 优雅等待 Chrome 退出，超时后强制终止
    await this.stopChrome();
    console.log("Browser closed");
  }

  /** 优雅关闭 Chrome：先等待自然退出，超时后 SIGKILL 强制终止 */
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

  /** 终止已跟踪的 Chrome 子进程 */
  private killChrome(): void {
    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
  }

  /** 终止占用本实例 CDP 端口且使用相同 profile 的残留 Chrome 进程 */
  private killChromeOnPort(): void {
    // 精确匹配 CDP 端口 + profile 目录，避免误杀用户自己的 Chrome
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
          // 进程已退出
        }
      }
    } catch {
      // pgrep 不可用或无匹配 — 正常
    }
  }
}
