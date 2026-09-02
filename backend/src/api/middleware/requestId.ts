import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../../logger.js";

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
    log: typeof logger;
  }
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestId(req: Request, res: Response, next: NextFunction) {
  // Read incoming X-Request-ID header and validate it
  const incomingId = req.headers["x-request-id"];
  const clientId = typeof incomingId === "string" ? incomingId : undefined;
  
  // Use client-provided UUID if valid, otherwise generate new one
  const id = clientId && UUID_V4_REGEX.test(clientId) ? clientId : randomUUID();
  
  req.requestId = id;
  req.log = logger.child({ requestId: id });
  res.setHeader("X-Request-ID", id);
  next();
}
