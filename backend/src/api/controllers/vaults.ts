import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
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
      category,
      cursor,
      sort,
      order,
      q,
    } = req.query as unknown as {
      page: number;
      pageSize: number;
      state?: string;
      category?: string;
      cursor?: string;
      sort: "created_at" | "total_assets";
      order: "asc" | "desc";
      q?: string;
    };
    const result = await vaultService.listVaults({ page, pageSize, state, category, cursor, sort, order, q });
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

export async function listCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    const categories = await vaultService.listCategories();
    setCacheHeaders(res);
    res.json(categories);
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
    const etag = `W/"${createHash("sha1").update(JSON.stringify(vault)).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    const ifModifiedSince = req.headers["if-modified-since"];
    if (ifModifiedSince) {
      const since = new Date(ifModifiedSince);
      if (!isNaN(since.getTime()) && vault.updatedAt <= since) {
        res.status(304).end();
        return;
      }
    }
    setCacheHeaders(res);
    res.set("ETag", etag);
    res.set("Last-Modified", vault.updatedAt.toUTCString());
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
 * GET /api/v1/vaults/:contractId/holders
 *
 * Returns active holders for a vault, paginated and sorted descending by
 * shares by default. The total is the full active-holder count.
 */
export async function getVaultHolders(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const page = Number(req.query["page"] ?? 1);
    const pageSize = Number(req.query["pageSize"] ?? 20);
    const sort = req.query["sort"] === "deposited" ? "deposited" : "shares";

    const result = await vaultService.listVaultHolders(contractId, {
      page,
      pageSize,
      sort,
    });

    if (!result) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/operators
 *
 * Returns the current active operators for a vault.
 */
export async function getVaultOperators(req: Request, res: Response, next: NextFunction) {
  try {
    const vault = await vaultService.getVault(String(req.params["contractId"]));
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const operators = await vaultService.listVaultOperators(String(req.params["contractId"]));
    setCacheHeaders(res);
    res.json(operators);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/roles
 *
 * Returns the current active roles for a vault.
 */
export async function getVaultRoles(req: Request, res: Response, next: NextFunction) {
  try {
    const vault = await vaultService.getVault(String(req.params["contractId"]));
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const roles = await vaultService.listVaultRoles(String(req.params["contractId"]));
    setCacheHeaders(res);
    res.json(roles);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/holders/count
 *
 * Returns the active shareholder count for a vault.
 */
export async function getVaultHolderCount(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await vaultService.countVaultHolders(String(req.params["contractId"]));
    if (count == null) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    res.set("Cache-Control", "max-age=30");
    res.json({ count });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/holders/export.csv
 *
 * Exports active holders as CSV columns:
 * userAddress, shares, deposited, lastUpdatedAt.
 */
export async function exportVaultHoldersCsv(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const holders = await vaultService.getVaultHoldersForExport(contractId);
    if (!holders) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const columns = ["userAddress", "shares", "deposited", "lastUpdatedAt"];
    const rows = holders.map((holder) => [
      holder.userAddress,
      holder.shares,
      holder.deposited,
      holder.lastUpdatedAt.toISOString(),
    ]);
    const csv = [
      columns.map(csvEscape).join(","),
      ...rows.map((row) => row.map(csvEscape).join(",")),
    ].join("\r\n") + "\r\n";

    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="holders-${contractId}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/report?year=2025
 *
 * Returns a year-over-year summary of a vault's performance for tax and
 * reporting purposes.
 *
 * Response:
 *   { year, totalYieldDistributed, epochCount, averageYieldPerEpoch,
 *     startTotalAssets, endTotalAssets, netAssetGrowth }
 *
 * All monetary values are BigInt-safe strings.
 * Returns zeroes for a year with no epochs.
 */
export async function getVaultAnnualReport(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const yearParam = req.query["year"];
    if (typeof yearParam !== "string" || !/^\d{4}$/.test(yearParam)) {
      res.status(400).json({ error: "BadRequest", message: "year query parameter is required and must be a 4-digit year" });
      return;
    }
    const year = parseInt(yearParam, 10);

    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRow[0].id;

    const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
    const yearEnd = new Date(`${year + 1}-01-01T00:00:00.000Z`);

    // Aggregate epoch data for the requested year
    const epochRows = await query<{ epoch_count: string; total_yield: string }>(
      `SELECT COUNT(*)::text AS epoch_count,
              COALESCE(SUM(yield_amount::numeric), 0)::text AS total_yield
       FROM epochs
       WHERE vault_id = $1
         AND distributed_at >= $2
         AND distributed_at < $3`,
      [vaultId, yearStart, yearEnd],
    );

    const epochCount = parseInt(epochRows[0]?.epoch_count ?? "0", 10);
    const totalYieldDistributed = epochRows[0]?.total_yield ?? "0";
    const totalYieldBig = BigInt(Math.round(parseFloat(totalYieldDistributed)));
    const averageYieldPerEpoch = epochCount > 0
      ? (totalYieldBig / BigInt(epochCount)).toString()
      : "0";

    // Nearest snapshot at or after year start (startTotalAssets)
    const startSnapshotRows = await query<{ total_assets: string }>(
      `SELECT total_assets::text
       FROM vault_tvl_snapshots
       WHERE vault_id = $1 AND recorded_at >= $2
       ORDER BY recorded_at ASC
       LIMIT 1`,
      [vaultId, yearStart],
    );

    // Nearest snapshot at or before year end (endTotalAssets)
    const endSnapshotRows = await query<{ total_assets: string }>(
      `SELECT total_assets::text
       FROM vault_tvl_snapshots
       WHERE vault_id = $1 AND recorded_at < $2
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [vaultId, yearEnd],
    );

    const startTotalAssets = startSnapshotRows[0]?.total_assets ?? "0";
    const endTotalAssets = endSnapshotRows[0]?.total_assets ?? "0";

    const startBig = BigInt(Math.round(parseFloat(startTotalAssets)));
    const endBig = BigInt(Math.round(parseFloat(endTotalAssets)));
    const netAssetGrowth = (endBig - startBig).toString();

    setCacheHeaders(res);
    res.json({
      year,
      totalYieldDistributed: totalYieldBig.toString(),
      epochCount,
      averageYieldPerEpoch,
      startTotalAssets: startBig.toString(),
      endTotalAssets: endBig.toString(),
      netAssetGrowth,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/epochs/:epoch/breakdown?page=1&pageSize=20
 *
 * Returns a per-user yield breakdown for a specific epoch. For each holder,
 * computes yieldAmount = epochYield * userShares / totalShares.
 * Paginated with page + pageSize.
 * Returns 404 for a non-existent epoch.
 */
export async function getEpochBreakdown(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const epochParam = req.params["epoch"];
    const epochNum = parseInt(String(epochParam), 10);
    if (isNaN(epochNum) || epochNum < 0) {
      res.status(400).json({ error: "BadRequest", message: "epoch must be a non-negative integer" });
      return;
    }

    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query["pageSize"] ?? "20"), 10) || 20));
    const offset = (page - 1) * pageSize;

    // Look up vault and epoch
    const epochRows = await query<{ id: number; vault_id: number; yield_amount: string; total_shares: string }>(
      `SELECT e.id, e.vault_id, e.yield_amount, e.total_shares
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1 AND e.epoch = $2`,
      [contractId, epochNum],
    );

    if (epochRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Epoch not found" });
      return;
    }

    const { vault_id: vaultId, yield_amount: yieldAmount, total_shares: totalShares } = epochRows[0];

    // Use share_balance_snapshots for accurate per-epoch holder balances
    const countRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM share_balance_snapshots
       WHERE vault_id = $1 AND epoch = $2 AND shares > 0`,
      [vaultId, epochNum],
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const holderRows = await query<{ user_address: string; shares: string }>(
      `SELECT user_address, shares::text
       FROM share_balance_snapshots
       WHERE vault_id = $1 AND epoch = $2 AND shares > 0
       ORDER BY shares DESC
       LIMIT $3 OFFSET $4`,
      [vaultId, epochNum, pageSize, offset],
    );

    const yieldBig = BigInt(Math.round(parseFloat(yieldAmount)));
    const totalSharesBig = BigInt(Math.round(parseFloat(totalShares)));

    const data = holderRows.map((row) => {
      const userSharesBig = BigInt(Math.round(parseFloat(row.shares)));
      const yieldAmt = totalSharesBig > 0n
        ? (yieldBig * userSharesBig / totalSharesBig).toString()
        : "0";
      return {
        userAddress: row.user_address,
        shares: row.shares,
        yieldAmount: yieldAmt,
      };
    });

    setCacheHeaders(res);
    res.json({ data, total, page, pageSize, epochYield: yieldBig.toString() });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/search?q=&category=&state=&sort=&order=&page=&pageSize=
 *
 * Combined search endpoint that applies text search, category filter, state
 * filter, and sort independently (AND logic). All params validated with Zod.
 * Returns HTTP 400 for invalid combinations.
 *
 * #640
 */
export async function searchVaults(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      q,
      category,
      state,
      page,
      pageSize,
      sort,
      order,
      fuzzy,
    } = req.query as unknown as {
      q?: string;
      category?: string;
      state?: string;
      page: number;
      pageSize: number;
      sort: "created_at" | "total_assets";
      order: "asc" | "desc";
      fuzzy?: boolean;
    };
    const result = await vaultService.searchVaults({ q, category, state, page, pageSize, sort, order, fuzzy });
    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/name-check?name=<value>
 *
 * Returns { "available": true | false } indicating whether the vault name is
 * unique (case-insensitive). Returns HTTP 400 if name is missing or under 3
 * characters.
 *
 * #641
 */
export async function checkVaultName(req: Request, res: Response, next: NextFunction) {
  try {
    const name = req.query["name"];
    if (typeof name !== "string" || name.length < 3) {
      res.status(400).json({ error: "BadRequest", message: "name query parameter is required and must be at least 3 characters" });
      return;
    }

    const available = await vaultService.checkVaultName(name);
    setCacheHeaders(res);
    res.json({ available });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/trending
 *
 * Returns the top 10 vaults ordered by sum of deposited amounts in the last
 * 24 hours. Includes contractId, name, recentDepositVolume (sum as string).
 * Returns [] if no deposits occurred recently.
 *
 * #642
 */
export async function getTrendingVaults(_req: Request, res: Response, next: NextFunction) {
  try {
    const trending = await vaultService.getTrendingVaults();
    setCacheHeaders(res);
    res.json(trending);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/new?days=7
 *
 * Returns vaults created within the given number of days (1-30, default 7),
 * ordered by created_at DESC. Returns the same vault shape as GET /api/v1/vaults.
 *
 * #643
 */
export async function getNewVaults(req: Request, res: Response, next: NextFunction) {
  try {
    const daysParam = req.query["days"];
    const days = typeof daysParam === "string" && /^\d+$/.test(daysParam)
      ? Math.min(30, Math.max(1, parseInt(daysParam, 10)))
      : 7;

    const vaults = await vaultService.getNewVaults(days);
    setCacheHeaders(res);
    res.json(vaults);
  } catch (err) {
    next(err);
  }
}

export async function getCompoundProjection(req: Request, res: Response, next: NextFunction) {
  try {
    const sharesParam = req.query.shares;
    const epochsParam = req.query.epochs;

    if (typeof sharesParam !== "string" || !/^\d+$/.test(sharesParam)) {
      res.status(400).json({
        error: "BadRequest",
        message: "shares query parameter is required and must be a positive integer",
      });
      return;
    }

    if (typeof epochsParam !== "string" || !/^\d+$/.test(epochsParam)) {
      res.status(400).json({
        error: "BadRequest",
        message: "epochs query parameter is required and must be a positive integer",
      });
      return;
    }

    const shares = BigInt(sharesParam);
    const epochs = parseInt(epochsParam, 10);

    if (shares <= 0n) {
      res.status(400).json({
        error: "BadRequest",
        message: "shares must be greater than zero",
      });
      return;
    }

    if (epochs <= 0) {
      res.status(400).json({
        error: "BadRequest",
        message: "epochs must be greater than zero",
      });
      return;
    }

    const projection = await vaultService.getCompoundProjection(
      String(req.params["contractId"]),
      sharesParam,
      epochs,
    );

    if (!projection) {
      res.status(404).json({
        error: "NotFound",
        message: "Vault has no epoch history to project from",
      });
      return;
    }

    res.json(projection);
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

export async function getVaultOperators(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const vaultExists = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultExists.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const operators = await vaultService.getVaultOperators(contractId);
    setCacheHeaders(res);
    res.json(operators);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/operators/log
 *
 * Returns a chronological history of operator additions and removals
 * for a vault, sourced from indexed_events. Empty logs return [].
 */
export async function getOperatorLog(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query["pageSize"] ?? "20"), 10) || 20));

    const result = await vaultService.getOperatorLog(contractId, page, pageSize);
    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
/**
 * GET /api/v1/vaults/maturing-soon?days=30
 *
 * Returns active vaults whose maturity_date falls within the next `days` days
 * (1–90, default 30). Each entry includes a daysUntilMaturity integer.
 *
 * #644
 */
export async function getMaturingSoonVaults(req: Request, res: Response, next: NextFunction) {
  try {
    const daysParam = req.query["days"];
    const days = typeof daysParam === "string" && /^\d+$/.test(daysParam)
      ? Math.min(90, Math.max(1, parseInt(daysParam, 10)))
      : 30;

    const vaults = await vaultService.getMaturitySoonVaults(days);
    setCacheHeaders(res);
    res.json(vaults);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/fully-funded
 *
 * Returns Funding-state vaults where total_assets >= funding_target, ordered
 * by funding ratio descending (most overfunded first). Each entry includes
 * fundingProgress as a percentage.
 *
 * #645
 */
export async function getFullyFundedVaults(_req: Request, res: Response, next: NextFunction) {
  try {
    const vaults = await vaultService.getFullyFundedVaults();
    setCacheHeaders(res);
    res.json(vaults);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/similar
 *
 * Returns up to 5 active vaults in the same rwa_category as the target vault,
 * sorted by TVL proximity (closest total_assets first). Excludes the target
 * vault itself. Returns [] when no similar vaults exist.
 *
 * #647
 */
export async function getSimilarVaults(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const similar = await vaultService.getSimilarVaults(contractId);
    if (similar === null) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    setCacheHeaders(res);
    res.json(similar);
  } catch (err) {
    next(err);
  }
}
