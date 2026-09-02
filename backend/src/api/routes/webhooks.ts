import { Router } from "express";
import { z } from "zod";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  testWebhook,
  verifyWebhookSignature,
  getGlobalOptOut,
  setGlobalOptOut,
} from "../controllers/webhooks.js";
import { getWebhookStream } from "../controllers/webhooks-stream.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { sseLimitPerIp } from "../middleware/sseLimitPerIp.js";
import { KNOWN_EVENTS } from "../../services/notificationEvents.js";

const KNOWN_CHANNELS = ["webhook", "email", "slack"] as const;

export const createWebhookSchema = z.object({
  url: z.string().min(1, "URL or email is required"),
  events: z
    .array(z.enum(KNOWN_EVENTS))
    .min(1, "At least one event must be specified"),
  secret: z.string().optional(),
  channel: z.enum(KNOWN_CHANNELS).default("webhook"),
  // Lower value = higher priority; the order channels are attempted in (#1025).
  priority: z.number().int().optional(),
  // Max deliveries per clock hour before events are throttled (#1022).
  // Omit or null for no limit.
  maxPerHour: z.number().int().positive().nullable().optional(),
});

const webhookParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, "ID must be a positive integer"),
});

/** Schema for POST /webhooks/verify-signature (#664) */
export const verifySignatureSchema = z.object({
  payload: z.string(),
  signature: z.string(),
  secret: z.string(),
});

/** Schema for PUT /webhooks/opt-out (#994) */
const optOutSchema = z.object({
  enabled: z.boolean(),
});

export const webhooksRouter = Router();

webhooksRouter.use(requireApiKey());

webhooksRouter.post("/", validateBody(createWebhookSchema), createWebhook);
webhooksRouter.get("/", listWebhooks);
webhooksRouter.get("/:id/stream", sseLimitPerIp(), validateParams(webhookParamsSchema), getWebhookStream);
webhooksRouter.delete("/:id", validateParams(webhookParamsSchema), deleteWebhook);

/** POST /webhooks/verify-signature — verify HMAC signature (#664) */
webhooksRouter.post(
  "/verify-signature",
  validateBody(verifySignatureSchema),
  verifyWebhookSignature,
);

/** POST /admin/webhooks/:id/test — send test ping (#666) */
webhooksRouter.post("/:id/test", validateParams(webhookParamsSchema), testWebhook);

/** GET/PUT /webhooks/opt-out — global notification opt-out (#994) */
webhooksRouter.get("/opt-out", getGlobalOptOut);
webhooksRouter.put("/opt-out", validateBody(optOutSchema), setGlobalOptOut);
