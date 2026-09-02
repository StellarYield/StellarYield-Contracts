import type { ErrorRequestHandler } from "express";
import { logger } from "../../logger.js";

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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  (req.log ?? logger).error(err, "Unhandled error");

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  res.status(err.statusCode ?? 500).json({
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    error: err.name ?? "InternalServerError",
    message: err.message ?? "An unexpected error occurred",
    statusCode: err.statusCode ?? 500,
  });
};
