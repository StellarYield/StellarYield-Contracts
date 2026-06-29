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

export async function getWebhookDeliveries(req: Request, res: Response, next: NextFunction) {
  try {
    const webhookId = parseInt(req.params["id"] as string, 10);
    if (isNaN(webhookId) || webhookId <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid webhook ID" });
      return;
    }

    const webhookRows = await query<{ id: number }>("SELECT id FROM webhooks WHERE id = $1", [webhookId]);
    if (webhookRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Webhook not found" });
      return;
    }

    const rawPage = parseInt(String(req.query["page"] ?? "1"), 10);
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(String(req.query["pageSize"] ?? "20"), 10);
    const pageSize = Math.max(1, Math.min(50, isNaN(rawPageSize) ? 20 : rawPageSize));
    const offset = (page - 1) * pageSize;

    const countRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text as count FROM webhook_deliveries WHERE webhook_id = $1",
      [webhookId],
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const rows = await query<{
      id: number;
      attempt: number;
      delivered_at: Date | null;
      last_error: string | null;
      next_retry_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, attempt, delivered_at, last_error, next_retry_at, created_at
       FROM webhook_deliveries
       WHERE webhook_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [webhookId, pageSize, offset],
    );

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        attempt: r.attempt,
        deliveredAt: r.delivered_at,
        lastError: r.last_error,
        nextRetryAt: r.next_retry_at,
        createdAt: r.created_at,
      })),
      total,
      page,
      pageSize,
    });
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

export async function getArchivedVaults(_req: Request, res: Response, next: NextFunction) {
  try {
    const { VaultService } = await import("../../services/vault.js");
    const vaultService = new VaultService();
    const vaults = await vaultService.listArchivedVaults();
    res.json(vaults);
  } catch (err) {
    next(err);
  }
}

export async function getTotalSupplyConsistency(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = req.query["contractId"] as string | undefined;

    if (!contractId) {
      res.status(400).json({ error: "Bad Request", message: "contractId query parameter is required" });
      return;
    }

    const { VaultService } = await import("../../services/vault.js");
    const { readTotalSupply } = await import("../../services/stellar.js");

    const vaultService = new VaultService();
    const vault = await vaultService.getVault(contractId);

    if (!vault) {
      res.status(404).json({ error: "Not Found", message: "Vault not found" });
      return;
    }

    const dbTotalSupply = BigInt(vault.totalSupply);

    let chainTotalSupply: bigint;
    try {
      chainTotalSupply = await readTotalSupply(contractId);
    } catch (err) {
      logger.error({ err, contractId }, "RPC error fetching chain total supply");
      res.status(502).json({ error: "Bad Gateway", message: "Failed to fetch chain data" });
      return;
    }

    const delta = chainTotalSupply - dbTotalSupply;
    const consistent = delta === 0n;

    res.json({
      dbTotalSupply: dbTotalSupply.toString(),
      chainTotalSupply: chainTotalSupply.toString(),
      delta: delta.toString(),
      consistent,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDbStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      relname: string;
      n_live_tup: string;
      total_bytes: string;
    }>(
      `SELECT
         relname,
         n_live_tup::text,
         pg_total_relation_size(relid)::text AS total_bytes
       FROM pg_stat_user_tables
       ORDER BY pg_total_relation_size(relid) DESC`,
    );

    res.json({
      tables: rows.map((r) => ({
        name: r.relname,
        rowEstimate: parseInt(r.n_live_tup, 10),
        totalSizeBytes: parseInt(r.total_bytes, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
}
