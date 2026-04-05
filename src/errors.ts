// Unified error handling: error code enum, HTTP status mapping, custom exception class
//
// All business errors are thrown via ProxyError with an ErrorCode enum value.
// ErrorCode maps to HTTP status codes; the server.ts error handler generates responses accordingly.
// In RESPONSE_TIMEOUT scenarios, partialResponse carries the already-received partial reply,
// preventing total loss of results after long waits.

/** Business error codes, each mapped to an HTTP status code */
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

/** Error code to HTTP status code mapping */
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

/** Business-semantic proxy error with error code, HTTP status, and optional partial response */
export class ProxyError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Partial reply that may have been received before timeout */
  readonly partialResponse?: string;

  constructor(code: ErrorCode, message: string, partialResponse?: string) {
    super(message);
    this.name = "ProxyError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.partialResponse = partialResponse;
  }
}
