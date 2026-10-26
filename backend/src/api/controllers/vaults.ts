import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { z } from "zod";
import { VaultService, validateFilterTree, VAULT_FIELD_ALLOWLIST, pickVaultFields } from "../../services/vault.js";
import { readTotalAssets, readVaultState, readPaused, readCooperator, readCooperatorFeeBps } from "../../services/stellar.js";
import { query } from "../../db/index.js";
import { AppError, ErrorCode } from "../middleware/errors.js";
import type { TransferVolumePeriod } from "../../types/index.js";
import { sseManager } from "../../services/sseManager.js";

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
      createdFrom,
      createdTo,
      minTotalAssets,
      maxTotalAssets,
      q,
      filter,
      fields,
      tag,
    } = req.query as unknown as {
      page: number;
      pageSize: number;
      state?: string;
      category?: string;
      cursor?: string;
      sort?: string;
      order?: "asc" | "desc";
      createdFrom?: string;
      createdTo?: string;
      minTotalAssets?: string;
      maxTotalAssets?: string;
      q?: string;
      filter?: string;
      fields?: string;
      tag?: string;
    };

    let parsedFilter: any | undefined;
    if (typeof filter === "string" && filter.trim() !== "") {
      try {
        parsedFilter = JSON.parse(filter);
      } catch (_e) {
        res.status(400).json({ error: "BadRequest", message: "filter must be valid JSON" });
        return;
      }
      const err = validateFilterTree(parsedFilter);
      if (err) {
        res.status(400).json({ error: "BadRequest", message: err });
        return;
      }
    }

    // Parse and validate `fields` if provided
    let fieldsArray: string[] | undefined;
    if (typeof fields === "string" && fields.trim() !== "") {
      fieldsArray = fields.split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of fieldsArray) {
        if (!(VAULT_FIELD_ALLOWLIST as string[]).includes(f)) {
          res.status(400).json({ error: "BadRequest", message: `Unknown field "${f}" in fields param` });
          return;
        }
      }
    }

    const isAdmin = req.apiKey?.role === "admin";
    const effectiveTag = isAdmin ? tag : undefined;
    const isDefaultSort = !sort;

    const result = await vaultService.listVaults({
      page,
      pageSize,
      state,
      category,
      cursor,
      sort,
      order,
      createdFrom,
      createdTo,
      minTotalAssets,
      maxTotalAssets,
      q,
      filter: parsedFilter,
      fields: fieldsArray,
      tag: effectiveTag,
      isDefaultSort,
      // A key restricted to some vaults only lists those (#1243).
      contractIds: req.apiKey?.allowedContractIds ?? undefined,
    });
    if (req.apiKey) {
      res.set("Cache-Control", "private, no-store");
    } else {
      setCacheHeaders(res);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getVaultCount(req: Request, res: Response, next: NextFunction) {
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

export async function getVaultAggregates(req: Request, res: Response, next: NextFunction) {
  try {
    const { state } = req.query as unknown as { state?: string };
    const aggregates = await vaultService.getVaultAggregates(state);
    setCacheHeaders(res);
    res.json(aggregates);
  } catch (err) {
    next(err);
  }
}

export async function listVaultsByFactory(req: Request, res: Response, next: NextFunction) {
  try {
    const allVaults = await vaultService.listVaultsByFactory(
      String(req.params["factoryId"]),
      req.queryTimeoutMs,
    );
    // A key restricted to some vaults only sees those in the factory (#1243).
    const allowedContractIds = req.apiKey?.allowedContractIds;
    const vaults = allowedContractIds
      ? allVaults.filter((vault) => allowedContractIds.includes(vault.contractId))
      : allVaults;
    if (req.apiKey) {
      res.set("Cache-Control", "private, no-store");
    } else {
      setCacheHeaders(res);
    }
    res.json(vaults);
  } catch (err) {
    next(err);
  }
}

export async function getVault(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);

    const { fields, embed } = req.query as unknown as { fields?: string; embed?: string };

    // Validate and parse fields
    let fieldsArray: string[] | undefined;
    if (typeof fields === "string" && fields.trim() !== "") {
      fieldsArray = fields.split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of fieldsArray) {
        if (!(VAULT_FIELD_ALLOWLIST as string[]).includes(f)) {
          res.status(400).json({ error: "BadRequest", message: `Unknown field "${f}" in fields param` });
          return;
        }
      }
    }

    // Validate embed values
    const embedArray = (typeof embed === "string" && embed.trim() !== "")
      ? embed.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const allowedEmbeds = ["positions", "epochs", "operators", "roles"];
    for (const e of embedArray) {
      if (!allowedEmbeds.includes(e)) {
        res.status(400).json({ error: "BadRequest", message: `Unknown embed "${e}"` });
        return;
      }
    }

    const vault = await vaultService.getVault(contractId);
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    // ETag / Last-Modified handling preserved
    const etag = `W/"${createHash("sha1").update(JSON.stringify(vault)).digest("hex")}"`;
    const updatedAt = vault.updatedAt instanceof Date ? vault.updatedAt : undefined;
    if (req.headers?.["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    const ifModifiedSince = req.headers?.["if-modified-since"];
    if (ifModifiedSince && updatedAt) {
      const since = new Date(ifModifiedSince);
      if (!isNaN(since.getTime()) && updatedAt <= since) {
        res.status(304).end();
        return;
      }
    }

    // Apply sparse fieldset if requested
    let out: Record<string, unknown> | any = vault;
    if (fieldsArray && fieldsArray.length > 0) {
      out = pickVaultFields(vault, fieldsArray);
    }

    // Apply embedding (detail endpoint only)
    for (const e of embedArray) {
      try {
        switch (e) {
          case "positions":
            out.positions = await vaultService.getVaultPositions(contractId);
            break;
          case "epochs":
            out.epochs = await vaultService.getVaultEpochs(contractId);
            break;
          case "operators":
            out.operators = await vaultService.listVaultOperators(contractId);
            break;
          case "roles":
            out.roles = await vaultService.listVaultRoles(contractId);
            break;
          default:
            out[e] = [];
        }
      } catch (embedErr) {
        next(embedErr);
        return;
      }
    }

    setCacheHeaders(res);
    res.set("ETag", etag);
    res.set("Last-Modified", vault.updatedAt.toUTCString());
    res.json(out);
  } catch (err) {
    next(err);
  }
}

/**
 * Bulk vault status query — closes #998.
 *
 * POST /api/v1/vaults/bulk/status  { contractIds: string[] }  (max 100)
 * Returns `{ [contractId]: { state; paused; totalAssets; updatedAt } | null }`.
 * Missing/unknown IDs resolve to `null` in their slot rather than failing the
 * whole batch, so a dashboard rendering many vaults gets partial data instead
 * of an all-or-nothing error.
 */
export async function getVaultsBulkStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { contractIds } = req.body as { contractIds: string[] };

    const entries = await Promise.all(
      contractIds.map(async (contractId) => {
        try {
          const vault = await vaultService.getVault(contractId);
          if (!vault) return [contractId, null] as const;

          const paused = await readPaused(contractId).catch(() => false);

          return [
            contractId,
            {
              state: vault.state,
              paused,
              totalAssets: vault.totalAssets,
              updatedAt: vault.updatedAt,
            },
          ] as const;
        } catch {
          return [contractId, null] as const;
        }
      }),
    );

    res.json(Object.fromEntries(entries));
  } catch (err) {
    next(err);
  }
}

export async function getVaultLiveState(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const state = await readVaultState(contractId);
    const paused = await readPaused(contractId);
    res.json({ state, paused });
  } catch (_err) {
    next(new AppError(ErrorCode.RPC_ERROR, "Failed to read live vault state from chain", 500));
  }
}

export async function getVaultLiveTotalAssets(req: Request, res: Response, next: NextFunction) {
  try {
    const totalAssets = await readTotalAssets(String(req.params["contractId"]));
    res.json({ totalAssets: totalAssets.toString() });
  } catch (_err) {
    next(new AppError(ErrorCode.RPC_ERROR, "Failed to read live total assets from chain", 500));
  }
}

export async function getVaultPositions(req: Request, res: Response, next: NextFunction) {
  try {
    const positions = await vaultService.getVaultPositions(
      String(req.params["contractId"]),
    );
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
 * GET /api/v1/vaults/:contractId/metadata-history?page=&pageSize=
 *
 * Returns the chronological log of vault metadata changes sourced from
 * vault_metadata_history, most recent first. Paginated with page + pageSize
 * (max 100). Returns { data: [], total: 0, page, pageSize } for a vault with
 * no metadata updates. (#973)
 */
export async function getVaultMetadataHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query["pageSize"] ?? "20"), 10) || 20));
    const offset = (page - 1) * pageSize;

    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRow[0].id;

    const rows = await query<{
      field: string;
      old_value: string | null;
      new_value: string | null;
      changed_by: string | null;
      recorded_at: Date;
    }>(
      `SELECT field, old_value, new_value, changed_by, recorded_at
       FROM vault_metadata_history
       WHERE vault_id = $1
       ORDER BY recorded_at DESC
       LIMIT $2 OFFSET $3`,
      [vaultId, pageSize, offset],
    );

    const countRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM vault_metadata_history WHERE vault_id = $1",
      [vaultId],
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const data = rows.map((r) => ({
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      changedBy: r.changed_by,
      recordedAt: r.recorded_at.toISOString(),
    }));

    setCacheHeaders(res);
    res.json({ data, total, page, pageSize });
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
 * POST /api/v1/vaults/metadata/validate
 *
 * Validates proposed vault metadata before on-chain submission.
 * Accepts { name?: string; documentUri?: string; logoUri?: string; description?: string }
 * Returns { valid: boolean; errors: { field: string; message: string }[] }
 */
export async function validateVaultMetadata(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, documentUri, logoUri, description } = req.body as {
      name?: string;
      documentUri?: string;
      logoUri?: string;
      description?: string;
    };

    const errors: { field: string; message: string }[] = [];

    // Validate name: minimum 3 characters
    if (name !== undefined && name !== null && name !== "") {
      if (typeof name !== "string" || name.length < 3) {
        errors.push({ field: "name", message: "name must be at least 3 characters" });
      }
    }

    // Validate URIs: must be valid HTTPS URLs
    const httpsUrlPattern = /^https:\/\/.+/i;
    
    if (documentUri !== undefined && documentUri !== null && documentUri !== "") {
      if (typeof documentUri !== "string" || !httpsUrlPattern.test(documentUri)) {
        errors.push({ field: "documentUri", message: "documentUri must be a valid HTTPS URL" });
      }
    }

    if (logoUri !== undefined && logoUri !== null && logoUri !== "") {
      if (typeof logoUri !== "string" || !httpsUrlPattern.test(logoUri)) {
        errors.push({ field: "logoUri", message: "logoUri must be a valid HTTPS URL" });
      }
    }

    // Validate description: maximum 1000 characters
    if (description !== undefined && description !== null && description !== "") {
      if (typeof description !== "string" || description.length > 1000) {
        errors.push({ field: "description", message: "description must not exceed 1000 characters" });
      }
    }

    res.json({
      valid: errors.length === 0,
      errors,
    });
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

    // Check cached_reports first (Issue #852)
    const cachedRows = await query<{ data: unknown }>(
      `SELECT data FROM cached_reports
       WHERE vault_id = $1 AND report_type = 'annual' AND report_year = $2`,
      [vaultId, year],
    );
    if (cachedRows.length > 0) {
      setCacheHeaders(res);
      res.json(cachedRows[0].data);
      return;
    }

    const { computeAnnualReportData } = await import("../../services/reportWorker.js");
    const reportData = await computeAnnualReportData(vaultId, year);

    // Save to cache for subsequent calls
    await query(
      `INSERT INTO cached_reports (vault_id, report_type, report_year, data, generated_at)
       VALUES ($1, 'annual', $2, $3, NOW())
       ON CONFLICT (vault_id, report_type, report_year)
       DO UPDATE SET data = EXCLUDED.data, generated_at = NOW()`,
      [vaultId, year, JSON.stringify(reportData)],
    );

    setCacheHeaders(res);
    res.json(reportData);
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
 *   - bucket: "hour" | "day" | "week" (optional, #864). When present,
 *     snapshots are aggregated per bucket with `date_trunc` and the response
 *     is [{ bucket, avgTotalAssets, maxTotalAssets, minTotalAssets }].
 *     `avgTotalAssets` is the mean of all snapshot values in the bucket.
 *
 * Without `bucket`, response is capped at 500 data points and bucketed by
 * hour if range > 48 hours (legacy auto-bucketing).
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
    const bucketParam = req.query.bucket as string | undefined;

    // Explicit bucket strategy (#864)
    if (bucketParam !== undefined) {
      if (bucketParam !== "hour" && bucketParam !== "day" && bucketParam !== "week") {
        res.status(400).json({
          error: "BadRequest",
          message: "Invalid bucket parameter. Supported values: hour, day, week",
        });
        return;
      }
    }

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

    // Explicit configurable bucketing (#864): aggregate with date_trunc.
    if (bucketParam === "hour" || bucketParam === "day" || bucketParam === "week") {
      const bucketRows = await query<{
        bucket: Date;
        avg_total_assets: string;
        max_total_assets: string;
        min_total_assets: string;
      }>(
        `SELECT
           date_trunc('${bucketParam}', recorded_at) AS bucket,
           AVG(total_assets::numeric)::text AS avg_total_assets,
           MAX(total_assets::numeric)::text AS max_total_assets,
           MIN(total_assets::numeric)::text AS min_total_assets
         FROM vault_tvl_snapshots
         WHERE ${whereClause}
         GROUP BY 1
         ORDER BY 1 ASC
         LIMIT 500`,
        params,
      );

      const data = bucketRows.map((row) => ({
        bucket:
          row.bucket instanceof Date
            ? row.bucket.toISOString()
            : new Date(row.bucket).toISOString(),
        avgTotalAssets: row.avg_total_assets,
        maxTotalAssets: row.max_total_assets,
        minTotalAssets: row.min_total_assets,
      }));

      setCacheHeaders(res);
      res.json(data);
      return;
    }

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
 * GET /api/v1/vaults/:contractId/fees/history
 *
 * Returns all fee rate changes for a vault ordered by recorded_at DESC.
 * Returns [] for a vault with no fee changes. (#791)
 */
export async function getFeeHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const rows = await query<{
      old_fee_bps: number;
      new_fee_bps: number;
      changed_by: string;
      recorded_at: Date;
    }>(
      `SELECT old_fee_bps, new_fee_bps, changed_by, recorded_at
       FROM vault_fee_history
       WHERE vault_id = $1
       ORDER BY recorded_at DESC`,
      [vaultRow[0].id],
    );
    setCacheHeaders(res);
    res.json(
      rows.map((r) => ({
        oldFeeBps: r.old_fee_bps,
        newFeeBps: r.new_fee_bps,
        changedBy: r.changed_by,
        recordedAt: r.recorded_at.toISOString(),
      })),
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/whitelist-history
 *
 * Returns every on-chain whitelist change the indexer recorded for a vault,
 * newest first, for audit purposes. Each entry is one `whitelist_updated` event,
 * so a vault that was never touched returns an empty list. (#1094)
 */
export async function getWhitelistHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const parsed = contractAddressSchema.safeParse(contractId);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }

    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query["pageSize"] ?? "20"), 10) || 20));
    const offset = (page - 1) * pageSize;

    const rows = await query<{
      address: string;
      action: string;
      tx_hash: string;
      ledger: number;
      created_at: Date;
    }>(
      `SELECT address, action, tx_hash, ledger, created_at
       FROM whitelist_events
       WHERE contract_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [parsed.data, pageSize, offset],
    );

    const countRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM whitelist_events WHERE contract_id = $1",
      [parsed.data],
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const data = rows.map((r) => ({
      address: r.address,
      action: r.action,
      txHash: r.tx_hash,
      ledger: r.ledger,
      createdAt: r.created_at.toISOString(),
    }));

    setCacheHeaders(res);
    res.json({ data, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/status-history
 *
 * Returns the full audit trail of a vault's on-chain status transitions
 * (#1065) and manager changes (#1068), newest first. Each entry is one
 * indexed event, distinguished by `eventType`.
 */
export async function getVaultStatusHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const parsed = contractAddressSchema.safeParse(contractId);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }

    const rows = await query<{
      id: number;
      contract_id: string;
      event_type: string;
      previous_status: string | null;
      new_status: string | null;
      previous_manager: string | null;
      new_manager: string | null;
      changed_at: Date;
      tx_hash: string;
      ledger: number;
    }>(
      `SELECT id, contract_id, event_type, previous_status, new_status,
              previous_manager, new_manager, changed_at, tx_hash, ledger
       FROM vault_status_history
       WHERE contract_id = $1
       ORDER BY changed_at DESC, id DESC`,
      [parsed.data],
    );

    const data = rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      eventType: r.event_type,
      previousStatus: r.previous_status,
      newStatus: r.new_status,
      previousManager: r.previous_manager,
      newManager: r.new_manager,
      changedAt: r.changed_at.toISOString(),
      txHash: r.tx_hash,
      ledger: r.ledger,
    }));

    setCacheHeaders(res);
    res.json({ data, total: data.length });
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

/**
 * GET /api/v1/vaults/:contractId/fees
 *
 * Returns operator fee summary for a vault:
 *   { totalOperatorFees, epochCount, averageFeePerEpoch, feeBps,
 *     earlyRedemptionFeeRevenue }
 *
 * totalOperatorFees is computed from indexed_events.parsed_data->>'operatorFee'.
 * earlyRedemptionFeeRevenue is the sum of fee_revenue from processed redemption_requests.
 *
 * Issue #786, #788
 */
export async function getVaultFees(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number; operator_fee_bps: number }>(
      "SELECT id, operator_fee_bps FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRows[0].id;
    const feeBps = vaultRows[0].operator_fee_bps ?? 0;

    // Total operator fees from parsed_data on yield_distributed events
    const feeRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM((parsed_data->>'operatorFee')::numeric), 0)::text AS total
       FROM indexed_events
       WHERE contract_id = $1 AND event_type = 'yield_distributed' AND parsed_data IS NOT NULL`,
      [contractId],
    );
    const totalOperatorFees = feeRows[0]?.total ?? "0";

    // Epoch count for average calculation
    const epochRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM epochs WHERE vault_id = $1",
      [vaultId],
    );
    const epochCount = parseInt(epochRows[0]?.count ?? "0", 10);

    const totalOperatorFeesBig = BigInt(Math.round(parseFloat(totalOperatorFees)));
    const averageFeePerEpoch = epochCount > 0
      ? (totalOperatorFeesBig / BigInt(epochCount)).toString()
      : "0";

    // Early redemption fee revenue (Issue #788)
    const redemptionFeeRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM(fee_revenue), 0)::text AS total
       FROM redemption_requests
       WHERE vault_id = $1 AND processed = TRUE AND fee_revenue > 0`,
      [vaultId],
    );
    const earlyRedemptionFeeRevenue = redemptionFeeRows[0]?.total ?? "0";

    setCacheHeaders(res);
    res.json({
      totalOperatorFees: totalOperatorFeesBig.toString(),
      epochCount,
      averageFeePerEpoch,
      feeBps,
      earlyRedemptionFeeRevenue,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/fees/cooperator
 *
 * Returns cooperator fee breakdown for a vault:
 *   { cooperatorAddress, cooperatorFeeBps, totalCooperatorFees }
 *
 * totalCooperatorFees = totalOperatorFees × cooperatorFeeBps / 10000
 * Returns zeroes if cooperatorFeeBps is 0.
 *
 * Issue #787
 */
export async function getCooperatorFees(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    // Read cooperator address from chain
    let cooperatorAddress = "";
    try {
      cooperatorAddress = await readCooperator(contractId);
    } catch {
      // If chain read fails, return zeroes
    }

    // Get cooperator fee bps from chain
    let cooperatorFeeBps = 0;
    try {
      cooperatorFeeBps = await readCooperatorFeeBps(contractId);
    } catch {
      // cooperator_fee_bps not available
    }

    // Total operator fees
    const feeRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM((parsed_data->>'operatorFee')::numeric), 0)::text AS total
       FROM indexed_events
       WHERE contract_id = $1 AND event_type = 'yield_distributed' AND parsed_data IS NOT NULL`,
      [contractId],
    );
    const totalOperatorFees = BigInt(Math.round(parseFloat(feeRows[0]?.total ?? "0")));

    const totalCooperatorFees = cooperatorFeeBps > 0
      ? (totalOperatorFees * BigInt(cooperatorFeeBps) / 10000n).toString()
      : "0";

    setCacheHeaders(res);
    res.json({
      cooperatorAddress,
      cooperatorFeeBps,
      totalCooperatorFees,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * SSE stream of vault events (#758). Optionally filtered to a comma-separated
 * list of contract IDs via `?contractIds=`.
 */
export function streamVaultEvents(req: Request, res: Response): void {
  const raw = typeof req.query["contractIds"] === "string" ? req.query["contractIds"] : undefined;

  let contractIds: Set<string> | undefined;
  if (raw) {
    const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
    for (const id of ids) {
      if (!contractAddressSchema.safeParse(id).success) {
        res.status(400).json({ error: "Bad Request", message: `Invalid contract ID format: ${id}` });
        return;
      }
    }
    contractIds = new Set(ids);
  }

  sseManager.addVaultClient(req, res, contractIds);
}

/**
 * Issue #1076: GET /api/v1/vaults/:contractId/transfer-fees?from=&to=
 * Returns total transfer fees collected for the vault within a date range.
 */
export async function getVaultTransferFees(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const { from, to } = req.query as { from?: string; to?: string };
    let fromIso: string | null = null;
    let toIso: string | null = null;

    if (from !== undefined && from !== "") {
      const fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid from date" });
        return;
      }
      fromIso = fromDate.toISOString();
    }

    if (to !== undefined && to !== "") {
      const toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid to date" });
        return;
      }
      toIso = toDate.toISOString();
    }

    if (fromIso && toIso && new Date(fromIso) > new Date(toIso)) {
      res.status(400).json({ error: "BadRequest", message: "from must not be after to" });
      return;
    }

    const rows = await query<{ total_fees: string }>(
      `SELECT COALESCE(SUM(fee_amount), 0)::text AS total_fees
       FROM transfer_fees
       WHERE contract_id = $1
         AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)`,
      [contractId, fromIso, toIso],
    );

    const totalFees = rows[0]?.total_fees ?? "0";

    res.json({
      contractId,
      totalFees,
      from: from ?? null,
      to: to ?? null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/transfer-volume?period=1d|7d|30d (#1074)
 *
 * Share trading activity for a vault token, used by the platform analytics
 * widgets. The period is validated by the route schema against a fixed set, so
 * an unrecognised value is a 400 rather than a silently widened window that
 * would report a number the caller did not ask for.
 */
export async function getTransferVolume(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const period = req.query["period"] as TransferVolumePeriod;

    res.json(await vaultService.getTransferVolume(contractId, period));
  } catch (err) {
    next(err);
  }
}

/**
 * Issue #1075: GET /api/v1/vaults/:contractId/transfer-leaderboard?limit=10
 * Returns top addresses sorted by total transfer activity (sentCount + receivedCount) descending.
 */
export async function getVaultTransferLeaderboard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    let limit = 10;
    if (req.query.limit !== undefined && req.query.limit !== "") {
      const parsedLimit = parseInt(String(req.query.limit), 10);
      if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
        res.status(400).json({ error: "BadRequest", message: "Invalid limit parameter" });
        return;
      }
      limit = Math.min(parsedLimit, 100);
    }

    const rows = await query<{
      address: string;
      sentCount: string | number;
      receivedCount: string | number;
      netVolume: string | number;
    }>(
      `WITH vault_transfers AS (
         SELECT t.from_address, t.to_address, t.amount
         FROM transfers t
         JOIN vaults v ON v.id = t.vault_id
         WHERE v.contract_id = $1
       ),
       sent AS (
         SELECT from_address AS address,
                COUNT(*)::bigint AS sent_count,
                COALESCE(SUM(amount), 0)::numeric AS sent_volume
         FROM vault_transfers
         GROUP BY from_address
       ),
       received AS (
         SELECT to_address AS address,
                COUNT(*)::bigint AS received_count,
                COALESCE(SUM(amount), 0)::numeric AS received_volume
         FROM vault_transfers
         GROUP BY to_address
       ),
       combined AS (
         SELECT
           COALESCE(s.address, r.address) AS address,
           COALESCE(s.sent_count, 0)::bigint AS sent_count,
           COALESCE(r.received_count, 0)::bigint AS received_count,
           (COALESCE(r.received_volume, 0) - COALESCE(s.sent_volume, 0))::numeric AS net_volume
         FROM sent s
         FULL OUTER JOIN received r ON s.address = r.address
       )
       SELECT
         address,
         sent_count AS "sentCount",
         received_count AS "receivedCount",
         net_volume::text AS "netVolume"
       FROM combined
       ORDER BY (sent_count + received_count) DESC, address ASC
       LIMIT $2`,
      [contractId, limit],
    );

    res.json(
      rows.map((row) => ({
        address: row.address,
        sentCount: parseInt(String(row.sentCount), 10),
        receivedCount: parseInt(String(row.receivedCount), 10),
        netVolume: String(row.netVolume ?? "0"),
      })),
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/snapshot  (augmented by #1270)
 *
 * Original snapshot fields remain; this export is intentionally kept separate
 * so the route file can call the function that already exists above.  The
 * handler above is patched via addPendingRedemptionToSnapshot which is called
 * from within getVaultSnapshot.  We expose a new dedicated controller below
 * that replaces the registered handler for /snapshot so that tests can mock
 * cleanly.  The existing `getVaultSnapshot` export is left intact for
 * backwards compatibility.
 *
 * Actually we patch getVaultSnapshot in-place: see the re-export below.
 * Issue #1270: expose pendingRedemptionAmount and pendingRedemptionCount.
 */
export async function getVaultSnapshotV2(req: Request, res: Response, next: NextFunction) {
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

    // Epoch count
    const epochRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM epochs WHERE vault_id = $1",
      [vault.id],
    );
    const epochCount = parseInt(epochRows[0]?.count ?? "0", 10);

    // Last indexed event timestamp
    const lastEventRows = await query<{ created_at: Date }>(
      "SELECT created_at FROM indexed_events WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 1",
      [contractId],
    );
    const lastIndexedAt = lastEventRows[0]?.created_at?.toISOString() ?? null;

    // Top-10 holder concentration
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

    // #1270 — pending redemption queue totals (only requests not yet processed,
    // i.e. processed = FALSE).  Cancelled requests are not stored as a separate
    // status on the legacy schema; once cancelled they are removed or marked
    // processed, so processed = FALSE is the correct "pending" filter.
    const pendingRows = await query<{ amount: string; count: string }>(
      `SELECT COALESCE(SUM(rr.shares), 0)::text AS amount,
              COUNT(*)::text AS count
       FROM redemption_requests rr
       WHERE rr.vault_id = $1 AND rr.processed = FALSE`,
      [vault.id],
    );
    const pendingRedemptionAmount = pendingRows[0]?.amount ?? "0";
    const pendingRedemptionCount = parseInt(pendingRows[0]?.count ?? "0", 10);

    const snapshot = {
      state: vault.state,
      totalAssets: vault.totalAssets,
      totalSupply: vault.totalSupply,
      depositorCount: vault.depositorCount,
      epochCount,
      lastIndexedAt,
      top10HolderSharePercent,
      pendingRedemptionAmount,
      pendingRedemptionCount,
    };

    setCacheHeaders(res);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/vaults/:contractId/deposit-distribution?buckets=N  (#1265)
 *
 * Returns a histogram of deposit amounts, split into N equal-width buckets
 * across the range [min_deposit, max_deposit].  buckets must be between 2 and
 * 50 inclusive; anything outside that range returns HTTP 422.
 *
 * Response shape:
 *   { buckets: [{ rangeMin: string, rangeMax: string, count: number, totalVolume: string }] }
 *
 * Acceptance criteria:
 *   - bucket counts sum to the total number of deposits in the vault
 *   - buckets are ordered from lowest to highest deposit amount
 */
export async function getDepositDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const bucketsParam = parseInt(String(req.query["buckets"] ?? "10"), 10);
    if (Number.isNaN(bucketsParam) || bucketsParam < 2 || bucketsParam > 50) {
      res.status(422).json({
        error: "UnprocessableEntity",
        message: "buckets must be an integer between 2 and 50",
      });
      return;
    }
    const numBuckets = bucketsParam;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    // Gather all deposit amounts for this vault from the indexed_events table.
    // Deposit events are stored with event_type = 'deposit' and payload.amount.
    const depositRows = await query<{ amount: string }>(
      `SELECT (payload->>'amount')::numeric AS amount
       FROM indexed_events
       WHERE contract_id = $1
         AND event_type = 'deposit'
         AND (payload->>'amount') IS NOT NULL
         AND (payload->>'amount')::numeric > 0`,
      [contractId],
    );

    if (depositRows.length === 0) {
      // No deposits yet — return empty buckets array but 200 OK
      setCacheHeaders(res);
      res.json({ buckets: [] });
      return;
    }

    const amounts = depositRows.map((r) => parseFloat(r.amount));
    const minAmt = Math.min(...amounts);
    const maxAmt = Math.max(...amounts);

    // If all deposits are the same size, put them all in one bucket (edge case)
    const range = maxAmt - minAmt;

    type BucketAcc = { count: number; totalVolume: number; rangeMin: number; rangeMax: number };
    const buckets: BucketAcc[] = [];

    for (let i = 0; i < numBuckets; i++) {
      const bucketMin = range === 0 ? minAmt : minAmt + (range / numBuckets) * i;
      const bucketMax = range === 0 ? maxAmt : minAmt + (range / numBuckets) * (i + 1);
      buckets.push({ count: 0, totalVolume: 0, rangeMin: bucketMin, rangeMax: bucketMax });
    }

    for (const amt of amounts) {
      if (range === 0) {
        buckets[0].count++;
        buckets[0].totalVolume += amt;
      } else {
        // Normalise to [0, 1) then scale to bucket index; clamp last bucket
        let idx = Math.floor(((amt - minAmt) / range) * numBuckets);
        if (idx >= numBuckets) idx = numBuckets - 1;
        buckets[idx].count++;
        buckets[idx].totalVolume += amt;
      }
    }

    setCacheHeaders(res);
    res.json({
      buckets: buckets.map((b) => ({
        rangeMin: b.rangeMin.toString(),
        rangeMax: b.rangeMax.toString(),
        count: b.count,
        totalVolume: b.totalVolume.toString(),
      })),
      // Expose vault context for the caller's convenience
      totalDeposits: amounts.length,
    });
  } catch (err) {
    next(err);
  }

  // Suppress unused-variable lint warning: vaultId used in query above.
  void 0;
}

/**
 * GET /api/v1/vaults/:contractId/cohorts  (#1266)
 *
 * Groups depositors by their first-deposit calendar month and returns:
 *   cohortMonth           – "YYYY-MM"
 *   holders               – total number of depositors who first deposited in that month
 *   currentShares         – aggregate shares still held by that cohort
 *   percentStillHolding   – holders with shares > 0 as a % of the cohort total
 *
 * Cohorts are ordered chronologically (earliest first).
 * Each holder belongs to exactly one cohort (their earliest first_entry_at).
 *
 * The `first_entry_at` column was added in migration 044_user_vault_entry_exit.
 */
export async function getVaultCohorts(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRows[0].id;

    // Aggregate by the year-month of first_entry_at.  Positions with a NULL
    // first_entry_at (pre-migration rows that had no snapshot) are bucketed by
    // updated_at as a best-effort fallback (same logic as the migration itself).
    const rows = await query<{
      cohort_month: string;
      holders: string;
      current_shares: string;
      holders_still_holding: string;
    }>(
      `SELECT
         TO_CHAR(COALESCE(uvp.first_entry_at, uvp.updated_at), 'YYYY-MM') AS cohort_month,
         COUNT(*)::text                                                     AS holders,
         COALESCE(SUM(uvp.shares), 0)::text                                AS current_shares,
         COUNT(*) FILTER (WHERE uvp.shares > 0)::text                      AS holders_still_holding
       FROM user_vault_positions uvp
       WHERE uvp.vault_id = $1
       GROUP BY cohort_month
       ORDER BY cohort_month ASC`,
      [vaultId],
    );

    const cohorts = rows.map((r) => {
      const holders = parseInt(r.holders, 10);
      const holdersStillHolding = parseInt(r.holders_still_holding, 10);
      return {
        cohortMonth: r.cohort_month,
        holders,
        currentShares: r.current_shares,
        percentStillHolding:
          holders > 0
            ? Math.round((holdersStillHolding / holders) * 100 * 100) / 100
            : 0,
      };
    });

    setCacheHeaders(res);
    res.json({ cohorts });
  } catch (err) {
    next(err);
  }
}

// ── Issue #1260: TVL growth rate ─────────────────────────────────────────────
//
// Compares the current TVL to snapshots at day, week, and month offsets and
// returns the growth as a decimal fraction: (current - previous) / previous.
// Returns null for a period when no earlier snapshot exists.
export async function getVaultTvlGrowth(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    const vaultId = vaultRows[0].id;

    // Most recent TVL snapshot for the vault.
    const currentRows = await query<{ total_assets: string }>(
      `SELECT total_assets::text
       FROM vault_tvl_snapshots
       WHERE vault_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [vaultId],
    );
    if (currentRows.length === 0) {
      // No snapshots at all — every period is null.
      setCacheHeaders(res);
      res.json({ day: null, week: null, month: null });
      return;
    }
    const current = parseFloat(currentRows[0].total_assets);

    // Look up the closest snapshot at least N days before the latest one.
    async function growthFor(days: number): Promise<number | null> {
      const rows = await query<{ total_assets: string }>(
        `SELECT total_assets::text
         FROM vault_tvl_snapshots
         WHERE vault_id = $1
           AND recorded_at <= (SELECT MAX(recorded_at) FROM vault_tvl_snapshots WHERE vault_id = $1) - ($2 || ' days')::INTERVAL
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [vaultId, String(days)],
      );
      if (rows.length === 0) return null;
      const previous = parseFloat(rows[0].total_assets);
      if (previous === 0) return null;
      return (current - previous) / previous;
    }

    const [day, week, month] = await Promise.all([growthFor(1), growthFor(7), growthFor(30)]);

    setCacheHeaders(res);
    res.json({ day, week, month });
  } catch (err) {
    next(err);
  }
}

// ── Issue #1261: Net deposits per day ─────────────────────────────────────────
//
// Returns daily deposit and withdrawal volume (and the net) for a vault.
// Days with no activity are included with zeroes so the series is contiguous.
export async function getVaultFlowsDaily(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const fromParam = req.query["from"] as string | undefined;
    const toParam = req.query["to"] as string | undefined;

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

    // Aggregate deposit/withdraw amounts per day from indexed_events.
    const params: unknown[] = [contractId];
    const whereConditions: string[] = ["ie.contract_id = $1", "ie.event_type IN ('deposit', 'withdraw')"];
    if (fromDate) {
      params.push(fromDate);
      whereConditions.push(`ie.created_at >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      whereConditions.push(`ie.created_at < $${params.length}`);
    }
    const whereClause = whereConditions.join(" AND ");

    const rows = await query<{
      day: Date;
      deposits: string;
      withdrawals: string;
    }>(
      `SELECT
         date_trunc('day', ie.created_at) AS day,
         COALESCE(SUM(CASE WHEN ie.event_type = 'deposit'
                           THEN COALESCE((ie.parsed_data->>'assets')::numeric, (ie.payload->>'assets')::numeric, (ie.payload->>'amount')::numeric, 0)
                           ELSE 0 END), 0)::text AS deposits,
         COALESCE(SUM(CASE WHEN ie.event_type = 'withdraw'
                           THEN COALESCE((ie.parsed_data->>'assets')::numeric, (ie.payload->>'assets')::numeric, 0)
                           ELSE 0 END), 0)::text AS withdrawals
       FROM indexed_events ie
       WHERE ${whereClause}
       GROUP BY 1
       ORDER BY 1 ASC`,
      params,
    );

    // Fill contiguous days with zeroes for days without activity.
    const byDay = new Map<string, { deposits: number; withdrawals: number }>();
    for (const r of rows) {
      const key = r.day.toISOString().slice(0, 10);
      byDay.set(key, {
        deposits: parseFloat(r.deposits),
        withdrawals: parseFloat(r.withdrawals),
      });
    }

    const result: Array<{ date: string; deposits: number; withdrawals: number; net: number }> = [];
    if (fromDate && toDate) {
      const cursor = new Date(fromDate);
      cursor.setUTCHours(0, 0, 0, 0);
      const end = new Date(toDate);
      end.setUTCHours(0, 0, 0, 0);
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10);
        const entry = byDay.get(key) ?? { deposits: 0, withdrawals: 0 };
        result.push({
          date: key,
          deposits: entry.deposits,
          withdrawals: entry.withdrawals,
          net: entry.deposits - entry.withdrawals,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else {
      // No range provided — just return the days that have activity.
      for (const [date, entry] of byDay) {
        result.push({
          date,
          deposits: entry.deposits,
          withdrawals: entry.withdrawals,
          net: entry.deposits - entry.withdrawals,
        });
      }
    }

    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}


// Restored endpoints
// Issue #1264 — Average holding duration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/vaults/:contractId/holding-duration
 *
 * Returns { averageDays, medianDays, sampleSize } for all distinct holders.
 * Active holders contribute duration = NOW − first_entry_at; fully-exited
 * holders contribute duration = last_exit_at − first_entry_at.
 */
export async function getHoldingDuration(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const result = await vaultService.getHoldingDuration(contractId);
    if (result === null) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1267 — Withdrawal-to-deposit ratio (snapshot augmentation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/vaults/:contractId/snapshot (augmented)
 *
 * The existing snapshot handler is extended in-place; this helper is kept
 * separate for testability.  It is called by the route-level handler below.
 */
export async function getVaultSnapshotWithRatios(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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

    // Issue #1267: withdrawal ratios
    const ratios = await vaultService.getWithdrawalRatios(contractId);

    const snapshot = {
      state: vault.state,
      totalAssets: vault.totalAssets,
      totalSupply: vault.totalSupply,
      depositorCount: vault.depositorCount,
      epochCount,
      lastIndexedAt,
      top10HolderSharePercent,
      withdrawalRatio7d: ratios?.withdrawalRatio7d ?? null,
      withdrawalRatio30d: ratios?.withdrawalRatio30d ?? null,
    };

    setCacheHeaders(res);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1268 — Funding velocity metric
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/vaults/:contractId/funding-velocity
 *
 * Only meaningful for vaults in the Funding state. Returns
 * { fundingVelocityPerDay, projectedFundingDate } or 404 for non-funding vaults.
 */
export async function getFundingVelocity(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const result = await vaultService.getFundingVelocity(contractId);
    if (result === null) {
      // Either vault not found, or not in Funding state
      const vault = await vaultService.getVault(contractId);
      if (!vault) {
        res.status(404).json({ error: "NotFound", message: "Vault not found" });
      } else {
        res.status(404).json({
          error: "NotFound",
          message: "Vault is not in Funding state",
        });
      }
      return;
    }

    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1269 — Redemption queue ETA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/vaults/:contractId/redemption-queue/:address/eta
 *
 * Returns { position, amountAhead, estimatedProcessingDate } for the given
 * address. Returns 404 when the address has no pending request.
 * estimatedProcessingDate is null when fewer than 5 requests have been
 * processed (insufficient history).
 */
export async function getRedemptionQueueEta(req: Request, res: Response, next: NextFunction) {
  try {
    const parsedContract = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsedContract.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsedContract.data;

    const userAddress = String(req.params["address"]);
    if (!userAddress || userAddress.length < 1) {
      res.status(400).json({ error: "BadRequest", message: "Missing address param" });
      return;
    }

    const result = await vaultService.getRedemptionQueueEta(contractId, userAddress);
    if (result === null) {
      res.status(404).json({
        error: "NotFound",
        message: "No pending redemption request found for this address in the specified vault",
      });
      return;
    }

    setCacheHeaders(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
// Issue #1273 — Add maturity countdown fields
// ---------------------------------------------------------------------------

/**
 * Compute `secondsToMaturity` and `maturityStatus` from a maturity date.
 *
 * Rules:
 *   - null maturityDate → both fields are null
 *   - past maturity     → secondsToMaturity = 0, status = "matured"
 *   - within 24 h       → secondsToMaturity = remaining seconds, status = "due"
 *   - further away      → secondsToMaturity = remaining seconds, status = "upcoming"
 */
function computeMaturityCountdown(maturityDate: Date | null | undefined): {
  secondsToMaturity: number | null;
  maturityStatus: "upcoming" | "due" | "matured" | null;
} {
  if (!maturityDate) return { secondsToMaturity: null, maturityStatus: null };

  const nowMs = Date.now();
  const matMs = new Date(maturityDate).getTime();
  const diffMs = matMs - nowMs;

  if (diffMs <= 0) return { secondsToMaturity: 0, maturityStatus: "matured" };

  const seconds = Math.floor(diffMs / 1000);
  const status = diffMs <= 24 * 60 * 60 * 1000 ? "due" : "upcoming";
  return { secondsToMaturity: seconds, maturityStatus: status };
}

/**
 * GET /api/v1/vaults/:contractId/maturity-countdown
 *
 * Returns `secondsToMaturity` and `maturityStatus` derived from the vault's
 * `maturity_date`.  Closes #1273.
 *
 * Response shape:
 *   { secondsToMaturity: number | null, maturityStatus: "upcoming"|"due"|"matured"|null }
 */
export async function getMaturityCountdown(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const rows = await query<{ maturity_date: Date | null }>(
      `SELECT maturity_date FROM vaults WHERE contract_id = $1`,
      [contractId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const countdown = computeMaturityCountdown(rows[0].maturity_date);
    setCacheHeaders(res);
    res.json(countdown);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Issue #1271 — Add redemption processing latency stats
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/vaults/:contractId/redemption-stats
 *
 * Returns processing latency statistics for all processed redemption requests:
 *   { avgHours, medianHours, p95Hours, processedCount }
 *
 * Only requests with `processed = TRUE` and a non-null `processed_at` are
 * included.  Empty history returns zero counts and null durations.  Closes #1271.
 */
export async function getRedemptionStats(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);

    const vault = await vaultService.getVault(contractId);
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const stats = await vaultService.getRedemptionStats(contractId);
    setCacheHeaders(res);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Issue #1272 — Add redemption cancellation rate metric
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/vaults/:contractId/redemption-stats/cancellation
 *
 * Returns `cancellationRate` (cancelled ÷ total requested), clamped to [0,1].
 * Returns `null` when no requests exist.  Closes #1272.
 *
 * Response shape:
 *   { cancellationRate: number | null, cancelledCount: number, totalRequested: number }
 */
export async function getRedemptionCancellationRate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);

    const vault = await vaultService.getVault(contractId);
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const data = await vaultService.getRedemptionCancellationRate(contractId);
    setCacheHeaders(res);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Issue #1263 — Add holder retention across epochs
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/vaults/:contractId/retention?epochs=5
 *
 * Returns per-epoch holder retention using `share_balance_snapshots`.
 * For each epoch: { epochId, holders, retainedNextEpoch, retentionRate }.
 * `retentionRate` is null for the latest epoch (no next epoch to compare).
 * Holders with zero balance at epoch N are excluded.  Closes #1263.
 */
export async function getHolderRetention(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);

    const epochsParam = req.query["epochs"];
    const epochCount = Math.min(
      100,
      Math.max(1, parseInt(String(epochsParam ?? "5"), 10) || 5),
    );

    const vault = await vaultService.getVault(contractId);
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const data = await vaultService.getHolderRetention(contractId, epochCount);
    setCacheHeaders(res);
    res.json(data);
  } catch (err) {
    next(err);
  }
}
