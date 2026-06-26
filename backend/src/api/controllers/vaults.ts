import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { VaultService } from "../../services/vault.js";
import { readTotalAssets, readVaultState } from "../../services/stellar.js";
import { query } from "../../db/index.js";

const vaultService = new VaultService();
const contractAddressSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);

function setCacheHeaders(res: Response): void {
  res.set("Cache-Control", "max-age=10, stale-while-revalidate=60");
}

/**
 * Escape a single CSV field per RFC 4180: wrap in double quotes and double any
 * embedded quotes when the value contains a comma, quote, or newline.
 */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function listVaults(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      page,
      pageSize,
      state,
      sort,
      order,
    } = req.query as unknown as {
      page: number;
      pageSize: number;
      state?: string;
      sort: "created_at" | "total_assets";
      order: "asc" | "desc";
    };
    const result = await vaultService.listVaults({ page, pageSize, state, sort, order });
    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getVaultCount(_req: Request, res: Response, next: NextFunction) {
  try {
    const total = await vaultService.countVaults();
    setCacheHeaders(res);
    res.json({ total });
  } catch (err) {
    next(err);
  }
}

export async function listVaultsByFactory(req: Request, res: Response, next: NextFunction) {
  try {
    const vaults = await vaultService.listVaultsByFactory(String(req.params["factoryId"]));
    setCacheHeaders(res);
    res.json(vaults);
  } catch (err) {
    next(err);
  }
}

export async function getVault(req: Request, res: Response, next: NextFunction) {
  try {
    const vault = await vaultService.getVault(String(req.params["contractId"]));
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    setCacheHeaders(res);
    res.json(vault);
  } catch (err) {
    next(err);
  }
}

export async function getVaultLiveState(req: Request, res: Response) {
  try {
    const state = await readVaultState(String(req.params["contractId"]));
    res.json({ state });
  } catch (_err) {
    res.status(500).json({
      error: "RpcError",
      message: "Failed to read live vault state from chain",
    });
  }
}

export async function getVaultLiveTotalAssets(req: Request, res: Response) {
  try {
    const totalAssets = await readTotalAssets(String(req.params["contractId"]));
    res.json({ totalAssets: totalAssets.toString() });
  } catch (_err) {
    res.status(500).json({
      error: "RpcError",
      message: "Failed to read live total assets from chain",
    });
  }
}

export async function getVaultPositions(req: Request, res: Response, next: NextFunction) {
  try {
    const positions = await vaultService.getVaultPositions(String(req.params["contractId"]));
    res.json(positions);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/early-redemption-fee?shares=
 *
 * Returns a preview of the cost of redeeming `shares` early:
 *   { grossAssets, feeBps, feeAmount, netAssets }
 * All monetary values are BigInt-safe strings. Responds 400 when `shares` is
 * missing or non-positive, and 404 when the vault does not exist.
 */
export async function getEarlyRedemptionFee(req: Request, res: Response, next: NextFunction) {
  try {
    const sharesParam = req.query["shares"];
    if (typeof sharesParam !== "string" || !/^\d+$/.test(sharesParam)) {
      res.status(400).json({
        error: "BadRequest",
        message: "shares query parameter is required and must be a positive integer",
      });
      return;
    }

    const shares = BigInt(sharesParam);
    if (shares <= 0n) {
      res.status(400).json({
        error: "BadRequest",
        message: "shares must be greater than zero",
      });
      return;
    }

    const preview = await vaultService.getEarlyRedemptionFeePreview(
      String(req.params["contractId"]),
      shares,
    );
    if (!preview) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    res.json(preview);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/export.csv
 *
 * Streams vault data as a CSV attachment with columns:
 * contractId, state, totalAssets, totalSupply, depositorCount, epochCount,
 * expectedApy, maturityDate. Responds 404 when the vault does not exist.
 */
export async function exportVaultCsv(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const data = await vaultService.getVaultExportData(contractId);
    if (!data) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const columns = [
      "contractId",
      "state",
      "totalAssets",
      "totalSupply",
      "depositorCount",
      "epochCount",
      "expectedApy",
      "maturityDate",
    ];
    const row = [
      data.contractId,
      data.state,
      data.totalAssets,
      data.totalSupply,
      String(data.depositorCount),
      String(data.epochCount),
      data.expectedApy != null ? String(data.expectedApy) : "",
      data.maturityDate ? data.maturityDate.toISOString() : "",
    ];

    const csv = `${columns.map(csvEscape).join(",")}\r\n${row.map(csvEscape).join(",")}\r\n`;

    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="vault-${contractId}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

export async function getRedemptionQueue(req: Request, res: Response, next: NextFunction) {
  try {
    const vault = await vaultService.getVault(String(req.params["contractId"]));
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const queue = await vaultService.getRedemptionQueue(String(req.params["contractId"]));
    setCacheHeaders(res);
    res.json(queue);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/snapshot
 *
 * Returns a point-in-time read-only aggregate of vault state.
 * Includes: state, totalAssets, totalSupply, depositorCount, epochCount, lastIndexedAt
 */
export async function getVaultSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vault = await vaultService.getVault(contractId);
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    // Get epoch count for this vault
    const epochRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text as count FROM epochs WHERE vault_id = $1",
      [vault.id],
    );
    const epochCount = parseInt(epochRows[0]?.count ?? "0", 10);

    // Get last indexed event timestamp for this vault
    const lastEventRows = await query<{ created_at: Date }>(
      "SELECT created_at FROM indexed_events WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 1",
      [contractId],
    );
    const lastIndexedAt = lastEventRows[0]?.created_at?.toISOString() ?? null;

    // Compute top-10 holder concentration metric
    const top10Rows = await query<{ top10_shares: string }>(
      `SELECT COALESCE(SUM(shares), 0)::text AS top10_shares
       FROM (
         SELECT uvp.shares
         FROM user_vault_positions uvp
         WHERE uvp.vault_id = $1 AND uvp.shares > 0
         ORDER BY uvp.shares DESC
         LIMIT 10
       ) top10`,
      [vault.id],
    );
    const totalSupplyNum = parseFloat(vault.totalSupply);
    let top10HolderSharePercent: number | null = null;
    if (totalSupplyNum > 0) {
      const top10Shares = parseFloat(top10Rows[0]?.top10_shares ?? "0");
      top10HolderSharePercent = Math.round((top10Shares / totalSupplyNum) * 100 * 100) / 100;
    }

    const snapshot = {
      state: vault.state,
      totalAssets: vault.totalAssets,
      totalSupply: vault.totalSupply,
      depositorCount: vault.depositorCount,
      epochCount,
      lastIndexedAt,
      top10HolderSharePercent,
    };

    setCacheHeaders(res);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/holders/top?n=10
 *
 * Returns the top N shareholders (max 20) with rank, userAddress, shares, sharePercent.
 * sharePercent = shares / total_supply * 100.
 */
export async function getVaultTopHolders(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);

    const nParam = req.query["n"];
    const n = Math.min(20, Math.max(1, parseInt(String(nParam ?? "10"), 10) || 10));

    const vaultRows = await query<{ id: number; total_supply: string }>(
      "SELECT id, total_supply FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const { id: vaultId, total_supply } = vaultRows[0];
    const totalSupply = parseFloat(total_supply ?? "0");

    const rows = await query<{ user_address: string; shares: string }>(
      `SELECT user_address, shares
       FROM user_vault_positions
       WHERE vault_id = $1 AND shares > 0
       ORDER BY shares DESC
       LIMIT $2`,
      [vaultId, n],
    );

    const data = rows.map((row, index) => ({
      rank: index + 1,
      userAddress: row.user_address,
      shares: row.shares,
      sharePercent: totalSupply > 0
        ? Math.round((parseFloat(row.shares) / totalSupply) * 100 * 10000) / 10000
        : 0,
    }));

    setCacheHeaders(res);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/holders?search=<partial_address>
 *
 * Returns holders whose address matches the search query (ILIKE).
 * Requires at least 4 characters; returns HTTP 400 otherwise.
 * Limited to 20 results.
 */
export async function getVaultHolders(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const search = req.query["search"];

    if (typeof search !== "string" || search.length < 4) {
      res.status(400).json({
        error: "BadRequest",
        message: "search query parameter is required and must be at least 4 characters",
      });
      return;
    }

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRows[0].id;

    const rows = await query<{ user_address: string; shares: string; deposited: string; updated_at: Date }>(
      `SELECT user_address, shares, deposited, updated_at
       FROM user_vault_positions
       WHERE vault_id = $1 AND user_address ILIKE $2
       ORDER BY shares DESC
       LIMIT 20`,
      [vaultId, `%${search}%`],
    );

    const data = rows.map((row) => ({
      userAddress: row.user_address,
      shares: row.shares,
      deposited: row.deposited,
      updatedAt: row.updated_at,
    }));

    setCacheHeaders(res);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/tvl-history
 *
 * Returns TVL snapshots in the requested time range.
 * Query params:
 *   - from: ISO datetime (optional)
 *   - to: ISO datetime (optional)
 *
 * Response is capped at 500 data points and bucketed by hour if range > 48 hours.
 */
export async function getVaultTvlHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    // Parse query parameters
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;

    let fromDate: Date | null = null;
    let toDate: Date | null = null;

    if (fromParam) {
      fromDate = new Date(fromParam);
      if (isNaN(fromDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid from date format" });
        return;
      }
    }

    if (toParam) {
      toDate = new Date(toParam);
      if (isNaN(toDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid to date format" });
        return;
      }
    }

    // Get vault ID
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRow[0].id;

    // Build query
    const whereConditions: string[] = ["vault_id = $1"];
    const params: any[] = [vaultId];

    if (fromDate) {
      whereConditions.push(`recorded_at >= $${params.length + 1}`);
      params.push(fromDate);
    }
    if (toDate) {
      whereConditions.push(`recorded_at <= $${params.length + 1}`);
      params.push(toDate);
    }

    const whereClause = whereConditions.join(" AND ");

    // Determine if we need to bucket by hour
    let needsBucketing = false;
    let hourDiff = 0;

    if (fromDate && toDate) {
      hourDiff = Math.abs((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60));
      needsBucketing = hourDiff > 48;
    }

    let rows;
    if (needsBucketing) {
      // Bucket by hour: select one snapshot per hour (the latest one)
      rows = await query<{
        total_assets: string;
        total_supply: string;
        recorded_at: Date;
      }>(
        `SELECT 
           total_assets, 
           total_supply,
           recorded_at
         FROM vault_tvl_snapshots
         WHERE ${whereClause}
         ORDER BY recorded_at ASC
         LIMIT 500`,
        params,
      );

      // Client-side bucketing: group snapshots by hour and take the last one of each hour
      const buckets = new Map<number, typeof rows[number]>();
      for (const row of rows) {
        const hourKey = Math.floor(row.recorded_at.getTime() / (1000 * 60 * 60));
        buckets.set(hourKey, row);
      }
      rows = Array.from(buckets.values()).sort(
        (a, b) => a.recorded_at.getTime() - b.recorded_at.getTime(),
      );
    } else {
      // No bucketing: return all snapshots, limited to 500
      rows = await query<{
        total_assets: string;
        total_supply: string;
        recorded_at: Date;
      }>(
        `SELECT total_assets, total_supply, recorded_at
         FROM vault_tvl_snapshots
         WHERE ${whereClause}
         ORDER BY recorded_at ASC
         LIMIT 500`,
        params,
      );
    }

    // Transform response
    const data = rows.map((row) => ({
      totalAssets: row.total_assets,
      totalSupply: row.total_supply,
      recordedAt: row.recorded_at.toISOString(),
    }));

    setCacheHeaders(res);
    res.json(data);
  } catch (err) {
    next(err);
  }
}