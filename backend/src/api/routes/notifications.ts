import { Router } from "express";
import { z } from "zod";
import { previewNotification, notificationsHealth } from "../controllers/notifications.js";
import { requireApiKey } from "../middleware/auth.js";
import { ipAllowlist } from "../middleware/ipAllowlist.js";
import { validateBody } from "../middleware/validate.js";

export const previewSchema = z.object({
  eventType: z.string().min(1),
  channel: z.string().min(1),
  samplePayload: z.record(z.unknown()),
});

export const notificationsRouter = Router();

notificationsRouter.use(ipAllowlist());
notificationsRouter.use(requireApiKey({ minRole: "readonly" }));

/** GET /api/v1/admin/notifications/health — ping each active channel (#1027) */
notificationsRouter.get("/health", notificationsHealth);

/** POST /api/v1/admin/notifications/preview — render a template (#1026) */
notificationsRouter.post(
  "/preview",
  requireApiKey({ role: "admin" }),
  validateBody(previewSchema),
  previewNotification,
);
