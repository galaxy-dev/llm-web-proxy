// 统一错误处理：错误码枚举、HTTP 状态码映射、自定义异常类
//
// 所有业务错误通过 ProxyError 抛出，携带 ErrorCode 枚举值。
// ErrorCode → HTTP 状态码为固定映射，server.ts 的错误处理器据此生成响应。
// RESPONSE_TIMEOUT 场景下 partialResponse 携带已收到的部分回复，
// 避免长时间等待后完全丢失结果。

/** 业务错误码，每个码对应一个 HTTP 状态码 */
export enum ErrorCode {
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_CLOSED = "SESSION_CLOSED",
  CAPACITY_EXHAUSTED = "CAPACITY_EXHAUSTED",
  AUTH_EXPIRED = "AUTH_EXPIRED",
  PAGE_STRUCTURE_CHANGED = "PAGE_STRUCTURE_CHANGED",
  RESPONSE_TIMEOUT = "RESPONSE_TIMEOUT",
  BROWSER_ERROR = "BROWSER_ERROR",
  BAD_REQUEST = "BAD_REQUEST",
}

/** 错误码到 HTTP 状态码的映射 */
const HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.SESSION_CLOSED]: 410,
  [ErrorCode.CAPACITY_EXHAUSTED]: 429,
  [ErrorCode.AUTH_EXPIRED]: 401,
  [ErrorCode.PAGE_STRUCTURE_CHANGED]: 502,
  [ErrorCode.RESPONSE_TIMEOUT]: 504,
  [ErrorCode.BROWSER_ERROR]: 500,
  [ErrorCode.BAD_REQUEST]: 400,
};

/** 带业务语义的代理错误，包含错误码、HTTP 状态码和可选的部分响应 */
export class ProxyError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** 超时场景下可能已收到的部分回复 */
  readonly partialResponse?: string;

  constructor(code: ErrorCode, message: string, partialResponse?: string) {
    super(message);
    this.name = "ProxyError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.partialResponse = partialResponse;
  }
}
