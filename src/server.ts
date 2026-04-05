// HTTP API 层：基于 Fastify 的 RESTful 接口，提供会话管理和消息收发端点
//
// 薄路由层，业务逻辑全部委托给 SessionManager。
// 统一错误处理器将 ProxyError 映射为结构化 JSON 响应（error + message），
// RESPONSE_TIMEOUT 额外携带 partialResponse 字段。
// 服务绑定 127.0.0.1，仅本机访问，不做 Authorization 校验。

import Fastify from "fastify";
import type { BrowserManager } from "./browser-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { ChatRequest } from "./types.js";
import { ProxyError, ErrorCode } from "./errors.js";

/** 构建 Fastify HTTP 服务实例，注册所有路由和错误处理 */
export function buildServer(sessionManager: SessionManager, browserManager: BrowserManager) {
  const app = Fastify({ logger: true });

  // 统一错误处理：ProxyError、校验错误、未知错误
  app.setErrorHandler<Error>(function (err, _request, reply) {
    if (err instanceof ProxyError) {
      reply.code(err.httpStatus);
      const body: Record<string, string> = {
        error: err.code,
        message: err.message,
      };
      if (err.partialResponse) {
        body.partialResponse = err.partialResponse;
      }
      return body;
    }
    const fastifyErr = err as Error & { validation?: unknown; statusCode?: number };
    if (fastifyErr.validation) {
      reply.code(400);
      return {
        error: ErrorCode.BAD_REQUEST,
        message: fastifyErr.message,
      };
    }
    reply.code(fastifyErr.statusCode ?? 500);
    return {
      error: "INTERNAL_ERROR",
      message: err.message,
    };
  });

  // --- 健康检查 ---
  app.get("/health", async () => ({
    status: "ok",
    authenticated: browserManager.authenticated,
  }));

  // --- 列出所有会话 ---
  app.get("/sessions", async () => {
    return sessionManager.listSessions();
  });

  // --- 创建会话 ---
  app.post("/sessions", async (_request, reply) => {
    const session = await sessionManager.createSession();
    reply.code(201);
    return {
      sessionId: session.id,
      createdAt: session.createdAt.toISOString(),
    };
  });

  // --- 查询会话详情 ---
  app.get<{
    Params: { id: string };
  }>("/sessions/:id", async (request) => {
    const session = sessionManager.getSession(request.params.id);
    if (!session) {
      throw new ProxyError(ErrorCode.SESSION_NOT_FOUND, "Session not found");
    }
    return session;
  });

  // --- 发送消息 ---
  app.post<{
    Params: { id: string };
    Body: ChatRequest;
  }>("/sessions/:id/chat", {
    schema: {
      body: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1, maxLength: 100_000 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { message } = request.body;
    const startTime = Date.now();
    const response = await sessionManager.sendMessage(id, message);
    return {
      response,
      durationMs: Date.now() - startTime,
    };
  });

  // --- 关闭会话 ---
  app.delete<{
    Params: { id: string };
  }>("/sessions/:id", async (request, reply) => {
    await sessionManager.closeSession(request.params.id);
    reply.code(204);
  });

  return app;
}
