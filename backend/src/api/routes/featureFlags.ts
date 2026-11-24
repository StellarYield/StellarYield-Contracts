import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { listFlags, getFlag, upsertFlag } from "../../services/featureFlags.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

export const featureFlagsRouter = Router();

featureFlagsRouter.use(requireApiKey({ role: "admin" }));

/**
 * GET /api/v1/admin/feature-flags
 * List all feature flags.
 *
 * Closes #916
 */
featureFlagsRouter.get("/", (_req: Request, res: Response) => {
  res.json(listFlags());
});

featureFlagsRouter.get("/:name", (req: Request, res: Response) => {
  const name = String(req.params["name"]);
  const flag = getFlag(name);
  if (!flag) {
    res.status(404).json({ error: "NotFound", message: `Feature flag '${name}' not found` });
    return;
  }
  res.json(flag);
});

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  enabledForRoles: z.array(z.string()).optional(),
});

/**
 * PATCH /api/v1/admin/feature-flags/:name
 * Create or update a feature flag.
 *
 * Closes #916
 */
featureFlagsRouter.patch(
  "/:name",
  validateBody(patchSchema),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params["name"]);
      const existing = getFlag(name);
      if (!existing && Object.keys(req.body as object).length === 0) {
        res.status(404).json({ error: "NotFound", message: `Feature flag '${name}' not found` });
        return;
      }
      const updated = upsertFlag(name, req.body as {
        enabled?: boolean;
        rolloutPercent?: number;
        enabledForRoles?: string[];
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);
