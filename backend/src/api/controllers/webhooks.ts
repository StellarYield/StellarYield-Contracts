import type { Request, Response, NextFunction } from "express";
import { query } from "../../db/index.js";
import { validateWebhookUrl, NotificationService } from "../../services/notifications.js";

const notificationService = new NotificationService();

interface WebhookRow {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  created_at: Date;
  consecutive_failures: number;
  channel: string | null;
  priority: number;
  fallback_channel: number | null;
  max_per_hour: number | null;
}

function formatWebhook(w: WebhookRow) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    active: w.active,
    createdAt: w.created_at,
    consecutiveFailures: w.consecutive_failures ?? 0,
    channel: w.channel ?? "webhook",
    priority: w.priority ?? 0,
    fallbackChannel: w.fallback_channel ?? null,
    maxPerHour: w.max_per_hour ?? null,
  };
}

export async function createWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { url, events, secret, channel, priority, maxPerHour } = req.body as {
      url: string;
      events: string[];
      secret?: string;
      channel?: string;
      priority?: number;
      maxPerHour?: number | null;
    };

    if (
      maxPerHour != null &&
      (!Number.isInteger(maxPerHour) || maxPerHour <= 0)
    ) {
      res.status(400).json({
        error: "InvalidMaxPerHour",
        message: "maxPerHour must be a positive integer or null",
      });
      return;
    }

    const webhookChannel = channel ?? "webhook";

    if (webhookChannel === "webhook" || webhookChannel === "slack") {
      try {
        await validateWebhookUrl(url);
      } catch (err: any) {
        res.status(400).json({ error: "InvalidWebhookUrl", message: err.message });
        return;
      }
    } else if (webhookChannel === "email") {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(url)) {
        res.status(400).json({ error: "InvalidEmail", message: "Must be a valid email address" });
        return;
      }
    }

    const rows = await query<WebhookRow>(
      `INSERT INTO webhooks (url, events, secret, channel, priority, max_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, url, events, active, created_at, consecutive_failures, channel, priority, fallback_channel, max_per_hour`,
      [url, events, secret ?? null, webhookChannel, priority ?? 0, maxPerHour ?? null],
    );

    res.status(201).json(formatWebhook(rows[0]));
  } catch (err) {
    next(err);
  }
}

export async function listWebhooks(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<WebhookRow>(
      `SELECT id, url, events, active, created_at, consecutive_failures, channel, priority, fallback_channel, max_per_hour
       FROM webhooks
       WHERE active = TRUE
       ORDER BY priority ASC, created_at DESC`,
    );

    res.json(rows.map(formatWebhook));
  } catch (err) {
    next(err);
  }
}

export async function deleteWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params["id"] as string, 10);

    const rows = await query<{ id: number }>(
      "UPDATE webhooks SET active = FALSE WHERE id = $1 AND active = TRUE RETURNING id",
      [id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Webhook not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/admin/webhooks/:id/test
 * Sends a test ping to the webhook URL and returns delivery metadata.
 * Issue #666.
 */
export async function testWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "InvalidId", message: "Webhook ID must be a positive integer" });
      return;
    }

    const rows = await query<WebhookRow>(
      "SELECT id, url, events, active, created_at, consecutive_failures, secret, channel FROM webhooks WHERE id = $1",
      [id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Webhook not found" });
      return;
    }

    const webhook = rows[0] as WebhookRow & { secret: string | null };
    const result = await notificationService.testDeliver(webhook);

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/webhooks/opt-out
 * Returns the current global notification opt-out state.
 * Issue #994.
 */
export async function getGlobalOptOut(_req: Request, res: Response, next: NextFunction) {
  try {
    const enabled = await notificationService.isGloballyEnabled();
    res.json({ notificationsEnabled: enabled });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/v1/webhooks/opt-out
 * Sets the global notification opt-out flag. When disabled, no webhook
 * notifications are dispatched regardless of individual webhook subscriptions.
 * Issue #994.
 */
export async function setGlobalOptOut(req: Request, res: Response, next: NextFunction) {
  try {
    const { enabled } = req.body as { enabled: boolean };
    await notificationService.setGloballyEnabled(enabled);
    res.json({ notificationsEnabled: enabled });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/webhooks/verify-signature
 * Verifies an HMAC-SHA256 webhook signature.
 * Issue #664.
 */
export async function verifyWebhookSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const { payload, signature, secret } = req.body as {
      payload: string;
      signature: string;
      secret: string;
    };

    if (typeof payload !== "string" || typeof signature !== "string" || typeof secret !== "string") {
      res.status(400).json({ error: "BadRequest", message: "payload, signature, and secret are required strings" });
      return;
    }

    const valid = notificationService.verifySignature(payload, signature, secret);
    res.json({ valid });
  } catch (err) {
    next(err);
  }
}