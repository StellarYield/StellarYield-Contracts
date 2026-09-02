import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { generateSnippet, normalizeRoute } from "../../services/codegen.js";

const codegenSchema = z.object({
  route: z.string().min(1, "route is required"),
  method: z.string().min(1, "method is required"),
  params: z.record(z.unknown()).optional(),
  language: z.enum(["typescript", "curl"]),
});

/** The base URL snippets should call. Prefer the host the request came in on so
 * a snippet is copy-paste runnable against the same deployment; fall back to the
 * configured port for tooling that calls the controller without a Host header. */
function resolveBaseUrl(req: Request): string {
  const host = req.get("host");
  if (host) return `${req.protocol}://${host}`;
  return `http://localhost:${config.port}`;
}

/**
 * POST /api/v1/codegen — generate a curl or fetch-based TypeScript snippet for
 * calling a documented route (#943).
 *
 * The OpenAPI spec is the sole template source: an unknown route/method pair is
 * a 404 rather than a plausible-looking snippet for an endpoint that does not
 * exist.
 */
export function generateCodeSnippet(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = codegenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }

    const { route, method, params, language } = parsed.data;
    const result = generateSnippet({
      route,
      method,
      params,
      language,
      baseUrl: resolveBaseUrl(req),
    });

    if (!result) {
      res.status(404).json({
        error: "NotFound",
        message: `No documented route matches ${method.toUpperCase()} ${normalizeRoute(route)}`,
      });
      return;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}
