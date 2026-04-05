// 全局类型定义：配置、会话、请求/响应的接口
//
// 作为各模块间的契约层，所有跨模块传递的数据结构在此统一定义。
// SessionInfo 是对外暴露的会话视图，不包含内部实现细节（如 Page 句柄、锁）。
// SessionStatus 涵盖完整生命周期：active → closing → stale/error。

export interface AccountConfig {
  name: string;
  /** 浏览器存储状态的备份路径 */
  storageStatePath: string;
}

export interface Config {
  port: number;
  headless: boolean;
  /** Which AI provider to use: "chatgpt" | "claude" */
  provider: string;
  /** Provider base URL (resolved from provider definition if not set) */
  providerUrl: string;
  maxSessions: number;
  /** Chrome 远程调试端口 */
  cdpPort: number;
  account: AccountConfig;
  /** 长文本粘贴转附件后，自动填入的提示语 */
  attachmentPrompt: string;
  timeouts: {
    navigation: number;
    /** 等待 ChatGPT 回复的超时时间 */
    response: number;
    /** 判定回复文本稳定（不再变化）的等待时间 */
    stability: number;
  };
  /** SSE 心跳间隔（秒），防止空闲超时断连 */
  sseKeepaliveSec: number;
  /** SSE 断连后 session 保留的宽限期（秒），超时未认领则删除 */
  orphanGraceSec: number;
}

export type SessionStatus = "active" | "closing" | "stale" | "error";

export interface SessionInfo {
  id: string;
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
