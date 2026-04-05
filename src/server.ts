// HTTP API layer: Fastify-based RESTful endpoints for session management and messaging
//
// Thin routing layer; all business logic is delegated to SessionManager.
// Unified error handler maps ProxyError to structured JSON responses (error + message).
// RESPONSE_TIMEOUT additionally carries a partialResponse field.
// Server binds to 127.0.0.1, local access only, no Authorization checks.

import Fastify from "fastify";
import type { BrowserManager } from "./browser-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { ChatRequest } from "./types.js";
import { ProxyError, ErrorCode } from "./errors.js";

/** Build the Fastify HTTP server instance with all routes and error handling */
export function buildServer(sessionManager: SessionManager, browserManager: BrowserManager) {
  const app = Fastify({ logger: true });

  // Unified error handler: ProxyError, validation errors, unknown errors
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

  // --- Health check ---
  app.get("/health", async () => ({
    status: "ok",
    authenticated: browserManager.authenticated,
  }));

  // --- List all sessions ---
  app.get("/sessions", async () => {
    return sessionManager.listSessions();
  });

  // --- Create session ---
  app.post("/sessions", async (_request, reply) => {
    const session = await sessionManager.createSession();
    reply.code(201);
    return {
      sessionId: session.id,
      createdAt: session.createdAt.toISOString(),
    };
  });

  // --- Get session details ---
  app.get<{
    Params: { id: string };
  }>("/sessions/:id", async (request) => {
    const session = sessionManager.getSession(request.params.id);
    if (!session) {
      throw new ProxyError(ErrorCode.SESSION_NOT_FOUND, "Session not found");
    }
    return session;
  });

  // --- Send message ---
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

  // --- Close session ---
  app.delete<{
    Params: { id: string };
  }>("/sessions/:id", async (request, reply) => {
    await sessionManager.closeSession(request.params.id);
    reply.code(204);
  });

  return app;
}
