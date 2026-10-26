import type { ErrorRequestHandler, Request, Response } from "express";
import { logger } from "../../logger.js";
import { recordHttpError } from "../../services/metrics.js";
import { isDatabaseUnavailableError } from "../../db/unavailable.js";
import { sendStaleResponse } from "./staleResponse.js";
import { UNAVAILABLE_RETRY_AFTER_SECONDS, setRetryAfter } from "./retryAfter.js";

export enum ErrorCode {
  VAULT_NOT_FOUND = "VAULT_NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNAUTHORIZED = "UNAUTHORIZED",
  RATE_LIMITED = "RATE_LIMITED",
  RPC_ERROR = "RPC_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  NOT_FOUND = "NOT_FOUND",
  WEBHOOK_INVALID = "WEBHOOK_INVALID",
  QUERY_TIMEOUT = "QUERY_TIMEOUT",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

function routeLabel(req: Request): string {
  return req.route?.path ?? req.path;
}

/**
 * Stable, kebab-case slug for each error code. Problem `type` URIs are built
 * from these so clients can match on a standard, documented identifier.
 */
const PROBLEM_SLUGS: Record<ErrorCode, string> = {
  [ErrorCode.VAULT_NOT_FOUND]: "vault-not-found",
  [ErrorCode.USER_NOT_FOUND]: "user-not-found",
  [ErrorCode.VALIDATION_ERROR]: "validation-error",
  [ErrorCode.UNAUTHORIZED]: "unauthorized",
  [ErrorCode.RATE_LIMITED]: "rate-limited",
  [ErrorCode.RPC_ERROR]: "rpc-error",
  [ErrorCode.INTERNAL_SERVER_ERROR]: "internal-server-error",
  [ErrorCode.NOT_FOUND]: "not-found",
  [ErrorCode.WEBHOOK_INVALID]: "webhook-invalid",
  [ErrorCode.QUERY_TIMEOUT]: "query-timeout",
  [ErrorCode.SERVICE_UNAVAILABLE]: "service-unavailable",
};

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** RFC 7807 `type` URI for an error code (#1178). */
export function problemTypeForCode(code: ErrorCode): string {
  return `/problems/${PROBLEM_SLUGS[code] ?? "internal-server-error"}`;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ErrorCode;
  /** @deprecated Use `detail` — kept for backwards compatibility. */
  message: string;
  /** @deprecated Use `status` — kept for backwards compatibility. */
  statusCode: number;
  /** @deprecated Legacy error name — kept for backwards compatibility. */
  error?: string;
}

/**
 * Builds an RFC 7807 problem-details document. `instance` carries the request
 * ID so a failure can be correlated with logs and the `X-Request-ID` header.
 */
export function buildProblemDetails(
  code: ErrorCode,
  detail: string,
  status: number,
  req: Request,
  errorName?: string,
): ProblemDetails {
  const requestId = (req as Request & { requestId?: string }).requestId;
  const problem: ProblemDetails = {
    type: problemTypeForCode(code),
    title: STATUS_TITLES[status] ?? "Error",
    status,
    detail,
    instance: requestId ? `/requests/${requestId}` : (req.originalUrl ?? req.path ?? ""),
    code,
    message: detail,
    statusCode: status,
  };
  if (errorName) problem.error = errorName;
  return problem;
}

function sendProblem(
  res: Response,
  code: ErrorCode,
  detail: string,
  status: number,
  req: Request,
  errorName?: string,
): void {
  res.status(status);
  res.type("application/problem+json");
  res.json(buildProblemDetails(code, detail, status, req, errorName));
}

/**
 * The database is unreachable (#1254). A public vault read gets its last stored
 * copy, marked STALE. Anything else gets a 503 with `Retry-After` (#1253).
 */
function respondDatabaseUnavailable(err: unknown, req: Request, res: Response): void {
  (req.log ?? logger).warn({ err }, "Database unavailable");
  if (sendStaleResponse(req, res)) return;

  recordHttpError(routeLabel(req), 503);
  setRetryAfter(res, UNAVAILABLE_RETRY_AFTER_SECONDS);
  sendProblem(
    res,
    ErrorCode.SERVICE_UNAVAILABLE,
    "Service temporarily unavailable, please retry shortly",
    503,
    req,
    "ServiceUnavailable",
  );
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (isDatabaseUnavailableError(err)) {
    respondDatabaseUnavailable(err, req, res);
    return;
  }

  (req.log ?? logger).error(err, "Unhandled error");

  const statusCode = err instanceof AppError ? err.statusCode : (err.statusCode ?? 500);

  // Error-rate metric (#831) — 4xx and 5xx only, tagged with the route pattern.
  recordHttpError(routeLabel(req), statusCode);

  if (statusCode === 503) {
    setRetryAfter(res, UNAVAILABLE_RETRY_AFTER_SECONDS);
  }

  if (err instanceof AppError) {
    sendProblem(res, err.code, err.message, err.statusCode, req);
    return;
  }

  const status = err.statusCode ?? 500;
  sendProblem(
    res,
    ErrorCode.INTERNAL_SERVER_ERROR,
    err.message ?? "An unexpected error occurred",
    status,
    req,
    err.name ?? "InternalServerError",
  );
};

/**
 * Terminal 404 handler (#831). Without this Express answers unmatched paths
 * with its own plain-text 404 that never reaches the error handler, so those
 * responses would be missing from http_errors_total.
 */
export const notFoundHandler: import("express").RequestHandler = (req, _res, next) => {
  next(new AppError(ErrorCode.NOT_FOUND, `Route ${req.method} ${req.path} not found`, 404));
};

