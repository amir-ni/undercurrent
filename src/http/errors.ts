import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Stable, machine-readable error codes. Clients branch on `code`, never on `detail` wording.
 * Rendered as RFC 9457 problem+json by the app's error handler.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "REPO_NOT_ALLOWED"
  | "REPO_NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_AUTH"
  | "LLM_NOT_CONFIGURED"
  | "LLM_UNAVAILABLE"
  | "LLM_REFUSED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  REPO_NOT_ALLOWED: 403,
  REPO_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_RATE_LIMITED: 503,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_AUTH: 502,
  LLM_NOT_CONFIGURED: 503,
  LLM_UNAVAILABLE: 502,
  LLM_REFUSED: 422,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly retryAfterSeconds: number | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: { retryAfterSeconds?: number; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}
