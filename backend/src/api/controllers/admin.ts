import type { Request, Response, NextFunction } from "express";
import { query } from "../../db/index.js";
import { indexer } from "../../services/indexerSingleton.js";
import { logger } from "../../logger.js";
import { z } from "zod";

const contractAddressSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);

export async function getAdminStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const vaultCountRows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM vaults");
    const userCountRows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM users");
    const totalAssetsRows = await query<{ total: string }>("SELECT COALESCE(SUM(total_assets::numeric), 0)::text as total FROM vaults");
    const epochCountRows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM epochs");

    const vaultCount = parseInt(vaultCountRows[0]?.count ?? "0", 10);
    const userCount = parseInt(userCountRows[0]?.count ?? "0", 10);
    const totalValueLocked = totalAssetsRows[0]?.total ?? "0";
    const epochCount = parseInt(epochCountRows[0]?.count ?? "0", 10);

    res.json({ vaultCount, userCount, totalValueLocked, epochCount });
  } catch (err) {
    next(err);
  }
}

export async function getAdminIndexer(_req: Request, res: Response, next: NextFunction) {
  try {
    const running = indexer.isRunning();
    const lastLedger = await indexer.getLastIndexedLedger();
    const lastTickAtDate = indexer.getLastTickAt();
    const lastTickAt = lastTickAtDate ? lastTickAtDate.toISOString() : null;
    const eventsIndexed = await indexer.getEventsIndexedCount();

    res.json({ running, lastLedger, lastTickAt, eventsIndexed });
  } catch (err) {
    next(err);
  }
}

export async function backfillIndexer(req: Request, res: Response, next: NextFunction) {
  try {
    const backfillSchema = z.object({
      fromLedger: z.number().int().min(0),
      toLedger: z.number().int().min(0),
    });

    const parsed = backfillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid request body" });
      return;
    }

    const { fromLedger, toLedger } = parsed.data;

    if (fromLedger >= toLedger) {
      res.status(400).json({ error: "BadRequest", message: "fromLedger must be less than toLedger" });
      return;
    }

    if (toLedger - fromLedger > 10000) {
      res.status(400).json({ error: "BadRequest", message: "Range cannot exceed 10000 ledgers" });
      return;
    }

    // Queue the backfill asynchronously (non-blocking)
    indexer.queueBackfill(fromLedger, toLedger).catch((err) => {
      logger.error({ err }, "Backfill error");
    });

    // Return 202 Accepted immediately
    res.status(202).json({ queued: true, fromLedger, toLedger });
  } catch (err) {
    next(err);
  }
}

export async function deleteApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const keyId = String(req.params["id"]);
    const idNum = parseInt(keyId, 10);

    if (isNaN(idNum) || idNum <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid key ID" });
      return;
    }

    const rows = await query<{ id: number }>("SELECT id FROM api_keys WHERE id = $1", [idNum]);

    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "API key not found" });
      return;
    }

    await query("DELETE FROM api_keys WHERE id = $1", [idNum]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function getApiKeys(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      id: number;
      label: string | null;
      role: string;
      created_at: Date;
    }>(
      "SELECT id, label, role, created_at FROM api_keys ORDER BY created_at DESC",
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        role: row.role,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function getAdminEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const { contractId, eventType } = req.query as Record<string, string | undefined>;
    const params: any[] = [];
    const where: string[] = [];

    if (contractId) {
      params.push(contractId);
      where.push(`contract_id = $${params.length}`);
    }
    if (eventType) {
      params.push(eventType);
      where.push(`event_type = $${params.length}`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await query(
      `SELECT id, ledger, tx_hash, contract_id, event_type, payload, created_at
       FROM indexed_events
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT 50`,
      params,
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/admin/vaults/:contractId/audit
 *
 * Returns the indexed event history for a specific vault contract,
 * providing a full audit trail of all on-chain activity (deposits,
 * withdrawals, yield distributions, state transitions, etc.).
 *
 * Query params:
 *   - limit   (1–200, default 50)
 *   - offset  (default 0)
 *   - eventType  (optional filter, e.g. "deposit", "withdraw")
 */
export async function getVaultAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const rawLimit = parseInt(String(req.query["limit"] ?? "50"), 10);
    const limit = Math.max(1, Math.min(200, isNaN(rawLimit) ? 50 : rawLimit));
    const rawOffset = parseInt(String(req.query["offset"] ?? "0"), 10);
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);
    const eventType = typeof req.query["eventType"] === "string" ? req.query["eventType"] : undefined;

    const params: any[] = [contractId, limit, offset];
    const eventTypeFilter = eventType ? `AND event_type = $${params.push(eventType)}` : "";

    const rows = await query(
      `SELECT id, ledger, tx_hash, contract_id, event_type, payload, created_at
         FROM indexed_events
        WHERE contract_id = $1
              ${eventTypeFilter}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      params,
    );

    // Total count for pagination metadata
    const countParams: any[] = [contractId];
    const countEventTypeFilter = eventType ? `AND event_type = $${countParams.push(eventType)}` : "";
    const countRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count
         FROM indexed_events
        WHERE contract_id = $1
              ${countEventTypeFilter}`,
      countParams,
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    res.json({ data: rows, total, limit, offset });
  } catch (err) {
    next(err);
  }
}
