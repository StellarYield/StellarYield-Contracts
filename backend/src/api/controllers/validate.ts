import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { findBodySchema, normalizeRoute } from "../schemas/requestBodyRegistry.js";

const dryRunSchema = z.object({
  route: z.string().min(1, "route is required"),
  method: z.string().min(1, "method is required"),
  body: z.unknown(),
});

/**
 * POST /api/v1/validate — validate a request body against the schema of the
 * route it is destined for, without executing that route (#941).
 *
 * The dry run performs exactly the validation the real route performs and
 * nothing else, so a consumer can check a payload before committing to a
 * mutation. Unknown routes are a 404 rather than `valid: true`, so a typo in
 * `route` can never be mistaken for a passing payload.
 */
export function validateRequestBody(req: Request, res: Response, next: NextFunction) {
  try {
    const envelope = dryRunSchema.safeParse(req.body);
    if (!envelope.success) {
      res.status(400).json({ error: "ValidationError", issues: envelope.error.issues });
      return;
    }

    const { route, method, body } = envelope.data;
    const schema = findBodySchema(method, route);

    if (!schema) {
      res.status(404).json({
        error: "NotFound",
        message: `No request body schema is registered for ${method.toUpperCase()} ${normalizeRoute(route)}`,
      });
      return;
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      res.json({ valid: false, errors: result.error.issues });
      return;
    }

    res.json({ valid: true, errors: null });
  } catch (err) {
    next(err);
  }
}
