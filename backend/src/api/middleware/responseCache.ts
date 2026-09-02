import type { Request, Response, NextFunction } from "express";
import { logger } from "../../logger.js";

interface CachedResponse {
  body: string;
  statusCode: number;
  headers: Record<string, string>;
}

const responseCache = new Map<string, CachedResponse>();

export function cacheResponse(key: string, body: unknown, statusCode: number, headers: Record<string, string>): void {
  responseCache.set(key, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    statusCode,
    headers,
  });
}

export function getCachedResponse(key: string): CachedResponse | undefined {
  return responseCache.get(key);
}

export function invalidateCache(): void {
  responseCache.clear();
  logger.info("Response cache invalidated");
}

export function staticCacheMiddleware(cacheKey: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      res.set(cached.headers);
      res.status(cached.statusCode).send(cached.body);
      return;
    }
    next();
  };
}
