import type { Request, Response, NextFunction } from "express";
import { ROUTE_CACHE_CONTROL } from "../../config.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getCacheControlHeader(path: string): string {
  // Check exact path match or prefix match in ROUTE_CACHE_CONTROL map
  for (const [pattern, maxAge] of Object.entries(ROUTE_CACHE_CONTROL)) {
    if (path === pattern || path.startsWith(`${pattern}/`)) {
      return maxAge > 0 ? `public, max-age=${maxAge}` : "no-store";
    }
  }
  return "no-store";
}

export function cacheControl(
  configMap: Record<string, number> = ROUTE_CACHE_CONTROL,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();

    if (MUTATION_METHODS.has(method)) {
      res.setHeader("Cache-Control", "no-store");
    } else if (method === "GET" || method === "HEAD") {
      const path = req.path;
      let matchedMaxAge: number | undefined;

      for (const [pattern, maxAge] of Object.entries(configMap)) {
        if (path === pattern || path.startsWith(`${pattern}/`)) {
          matchedMaxAge = maxAge;
          break;
        }
      }

      if (matchedMaxAge !== undefined) {
        res.setHeader(
          "Cache-Control",
          matchedMaxAge > 0 ? `public, max-age=${matchedMaxAge}` : "no-store",
        );
      } else {
        res.setHeader("Cache-Control", "no-store");
      }
    }

    next();
  };
}
