import type { Request, Response, NextFunction } from "express";
import { query } from "../../db/index.js";
import { isKnownEvent } from "../../services/notificationEvents.js";
import {
  getPreferences,
  upsertPreferences,
  type PreferenceInput,
} from "../../services/notificationPreferences.js";

/**
 * GET /api/v1/users/:address/notification-preferences
 * Return all notification preference rows for the user (#989).
 */
export async function getNotificationPreferences(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const preferences = await getPreferences(address);
    res.json({ preferences });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/v1/users/:address/notification-preferences
 * Upsert an array of preference objects. Unknown event types are rejected
 * with HTTP 400 (#989).
 */
export async function updateNotificationPreferences(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const body = req.body as unknown;

    if (!Array.isArray(body)) {
      res.status(400).json({
        error: "ValidationError",
        message: "Request body must be an array of preference objects",
      });
      return;
    }

    const parsed: PreferenceInput[] = [];
    for (const raw of body) {
      if (typeof raw !== "object" || raw === null) {
        res.status(400).json({ error: "ValidationError", message: "Each preference must be an object" });
        return;
      }
      const item = raw as Record<string, unknown>;
      const eventType = item["eventType"];
      const channel = item["channel"];
      const enabled = item["enabled"];
      const vaultContractId = item["vaultContractId"];

      if (typeof eventType !== "string" || !isKnownEvent(eventType)) {
        res.status(400).json({
          error: "UnknownEventType",
          message: `Unknown event type: ${String(eventType)}`,
        });
        return;
      }
      if (typeof channel !== "string" || channel.length === 0) {
        res.status(400).json({ error: "ValidationError", message: "channel is required" });
        return;
      }
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "ValidationError", message: "enabled must be a boolean" });
        return;
      }
      if (vaultContractId != null && typeof vaultContractId !== "string") {
        res.status(400).json({ error: "ValidationError", message: "vaultContractId must be a string or null" });
        return;
      }

      parsed.push({
        eventType,
        channel,
        enabled,
        vaultContractId: (vaultContractId as string | undefined) ?? null,
      });
    }

    await upsertPreferences(address, parsed);
    const preferences = await getPreferences(address);
    res.json({ preferences });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/users/:address/subscriptions
 * Subscribe the user to a set of event types for a single vault. Stored as
 * enabled webhook preference rows scoped to that vault (#991).
 */
export async function createVaultSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const { contractId, events } = req.body as { contractId?: unknown; events?: unknown };

    if (typeof contractId !== "string" || contractId.length === 0) {
      res.status(400).json({ error: "ValidationError", message: "contractId is required" });
      return;
    }
    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: "ValidationError", message: "events must be a non-empty array" });
      return;
    }
    for (const event of events) {
      if (typeof event !== "string" || !isKnownEvent(event)) {
        res.status(400).json({ error: "UnknownEventType", message: `Unknown event type: ${String(event)}` });
        return;
      }
    }

    await upsertPreferences(
      address,
      (events as string[]).map((eventType) => ({
        eventType,
        channel: "webhook",
        enabled: true,
        vaultContractId: contractId,
      })),
    );

    res.status(201).json({ contractId, events });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/users/:address/subscriptions/:contractId
 * Remove every subscription the user has for that vault (#991).
 */
export async function deleteVaultSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const contractId = String(req.params["contractId"]);

    await query(
      `DELETE FROM user_notification_preferences
        WHERE user_address = $1 AND vault_contract_id = $2`,
      [address, contractId],
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/users/:address/subscriptions
 * List active per-vault subscriptions, grouped by vault (#991).
 */
export async function listVaultSubscriptions(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);

    const rows = await query<{ vault_contract_id: string; event_type: string }>(
      `SELECT vault_contract_id, event_type
         FROM user_notification_preferences
        WHERE user_address = $1
          AND vault_contract_id IS NOT NULL
          AND enabled = TRUE
        ORDER BY vault_contract_id, event_type`,
      [address],
    );

    const byVault = new Map<string, string[]>();
    for (const row of rows) {
      const events = byVault.get(row.vault_contract_id) ?? [];
      events.push(row.event_type);
      byVault.set(row.vault_contract_id, events);
    }

    const subscriptions = [...byVault.entries()].map(([contractId, events]) => ({
      contractId,
      events,
    }));

    res.json({ subscriptions });
  } catch (err) {
    next(err);
  }
}
