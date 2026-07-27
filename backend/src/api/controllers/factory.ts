import type { Request, Response, NextFunction } from "express";
import { query } from "../../db/index.js";
import { config } from "../../config.js";

// GET /api/v1/factory/admin-history — audit log of factory admin transfers (#839)
export async function getFactoryAdminHistory(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      old_admin: string;
      new_admin: string;
      ledger: number;
      recorded_at: Date;
    }>(
      `SELECT old_admin, new_admin, ledger, recorded_at
       FROM factory_admin_history
       ORDER BY recorded_at DESC, id DESC`,
    );

    res.json(
      rows.map((r) => ({
        oldAdmin: r.old_admin,
        newAdmin: r.new_admin,
        ledger: r.ledger,
        recordedAt: r.recorded_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/factory/vault-creation-rate — vault deployment rate over rolling windows (#840)
export async function getVaultCreationRate(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{ last24h: string; last7d: string; last30d: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text AS last24h,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text AS last7d,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::text AS last30d
       FROM vaults`,
    );

    const row = rows[0];
    res.json({
      last24h: parseInt(row?.last24h ?? "0", 10),
      last7d: parseInt(row?.last7d ?? "0", 10),
      last30d: parseInt(row?.last30d ?? "0", 10),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/factory/defaults — canonical default vault parameters (#841)
export async function getFactoryDefaults(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      parsed_data: { asset?: string; zkmeVerifier?: string; cooperator?: string } | null;
    }>(
      `SELECT parsed_data
       FROM indexed_events
       WHERE contract_id = $1 AND event_type = 'def_upd'
       ORDER BY ledger DESC
       LIMIT 1`,
      [config.stellar.vaultFactoryContractId],
    );

    const defaults = rows[0]?.parsed_data ?? null;
    res.json({
      defaultAsset: defaults?.asset ?? null,
      defaultZkmeVerifier: defaults?.zkmeVerifier ?? null,
      defaultCooperator: defaults?.cooperator ?? null,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/factory/events — chronological factory-level event log (#842)
export async function getFactoryEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, pageSize } = req.query as unknown as { page: number; pageSize: number };
    const offset = (page - 1) * pageSize;
    const factoryContractId = config.stellar.vaultFactoryContractId;

    const rows = await query<{
      event_type: string;
      ledger: number;
      tx_hash: string;
      created_at: Date;
    }>(
      `SELECT event_type, ledger, tx_hash, created_at
       FROM indexed_events
       WHERE contract_id = $1
       ORDER BY ledger DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [factoryContractId, pageSize, offset],
    );

    const countRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text as count FROM indexed_events WHERE contract_id = $1",
      [factoryContractId],
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    res.json({
      data: rows.map((r) => ({
        eventType: r.event_type,
        ledger: r.ledger,
        txHash: r.tx_hash,
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
