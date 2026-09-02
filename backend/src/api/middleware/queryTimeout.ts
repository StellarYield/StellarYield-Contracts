import type { Request, Response, NextFunction } from "express";
import { AppError, ErrorCode } from "./errors.js";
import { config } from "../../config.js";

export function queryTimeoutMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.queryTimeoutMs = config.db.queryTimeoutMs;
    next();
  };
}
