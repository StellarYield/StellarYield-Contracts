import type { Request, Response, NextFunction } from "express";

/**
 * Normalizes trailing slashes on API routes (#1182).
 *
 * Strips a single trailing slash from the request path (except for "/").
 * For non-GET methods, issues a 308 redirect if rewriting is not possible.
 * This ensures `/api/v1/vaults/` behaves the same as `/api/v1/vaults`.
 *
 * Query strings are preserved in the rewritten URL.
 */
export function normalizeTrailingSlash(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/" || !req.path.endsWith("/")) {
    next();
    return;
  }

  const originalPath = req.path;
  const normalizedPath = originalPath.slice(0, -1);
  const query = req.originalUrl.slice(originalPath.length);

  if (req.method === "GET" || req.method === "HEAD") {
    req.url = normalizedPath + query;
    next();
  } else {
    const redirectUrl = normalizedPath + query;
    res.redirect(308, redirectUrl);
  }
}
