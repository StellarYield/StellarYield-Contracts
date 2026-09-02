import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Request, Response, NextFunction } from "express";
import Cursor from "pg-cursor";
import { stringify } from "csv-stringify";
import { z } from "zod";
import { query, pool } from "../../db/index.js";
import { config } from "../../config.js";
import { seed } from "../../db/seed.js";
import { indexer } from "../../services/indexerSingleton.js";
import { jobQueue } from "../../services/jobQueue.js";
import { sseManager } from "../../services/sseManager.js";
import { logger } from "../../logger.js";
import { createAdminSessionToken, refreshAdminSessionToken } from "../middleware/auth.js";

export async function getSecurityEvents(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      id: number;
      event_type: string;
      ip_address: string | null;
      api_key_label: string | null;
      path: string | null;
      details: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT id, event_type, ip_address, api_key_label, path, details, created_at
       FROM security_events
       ORDER BY created_at DESC
       LIMIT 200`,
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        ipAddress: row.ip_address,
        apiKeyLabel: row.api_key_label,
        path: row.path,
        details: row.details,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

const stellarAddressSchema = z.string().length(56).regex(/^G[A-Z2-7]{55}$/);
const contractAddressSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);

function getClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || null;
  }
  if (Array.isArray(forwarded)) {
    return forwarded[0] ?? null;
  }
  return req.ip ?? null;
}

function getRequestBodyHash(body: unknown): string {
  const normalized = typeof body === "string"
    ? body
    : body == null
      ? ""
      : JSON.stringify(body);
  return createHash("sha256").update(normalized).digest("hex");
}

async function logAdminAudit(req: Request, action: string, target: string): Promise<void> {
  await query(
    `INSERT INTO admin_audit_log (api_key_label, action, target, ip_address, request_body_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [req.apiKey?.label ?? null, action, target, getClientIp(req), getRequestBodyHash(req.body)],
  );
}

interface ApiKeyRecord {
  id: number;
  role: string;
  label: string | null;
  expiresAt: Date | null;
  active: boolean;
  allowedMethods: string[] | null;
}

async function findApiKeyByValue(plaintext: string): Promise<ApiKeyRecord | null> {
  const keyHash = createHash("sha256").update(plaintext).digest("hex");
  const rows = await query<{
    id: number;
    role: string;
    label: string | null;
    expires_at: Date | null;
    active: boolean | null;
    allowed_methods: string[] | null;
  }>(
    'SELECT id, role, label, expires_at, active, allowed_methods FROM api_keys WHERE key_hash = $1',
    [keyHash],
  ).catch(() => []);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    role: row.role,
    label: row.label,
    expiresAt: row.expires_at,
    active: row.active ?? true,
    allowedMethods: row.allowed_methods ?? null,
  };
}

export async function createAdminSession(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = z.object({ apiKey: z.string().min(1, "apiKey is required") }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid request body" });
      return;
    }

    const apiKey = await findApiKeyByValue(parsed.data.apiKey);
    if (!apiKey) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid API key" });
      return;
    }

    // A session must never outlive the key it is minted from, so the same
    // lifecycle checks the auth middleware applies run here too (#934).
    if (!apiKey.active) {
      res.status(403).json({ error: "Forbidden", message: "API key has been deactivated" });
      return;
    }

    if (apiKey.role !== "admin") {
      res.status(403).json({ error: "Forbidden", message: "Admin API key required" });
      return;
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      res.status(401).json({ error: "Unauthorized", message: "API key has expired" });
      return;
    }

    // Exchanging a key for a session is an authentication, so it counts as use
    // and must not reset the inactivity clock silently (#933).
    void query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [apiKey.id]).catch(
      (err: unknown) => {
        logger.warn({ err, keyId: apiKey.id }, "Failed to update api_keys.last_used_at");
      },
    );

    const token = createAdminSessionToken(apiKey);
    res.json({ token, expiresInMinutes: config.adminSessionExpiryMinutes });
  } catch (err) {
    next(err);
  }
}

export async function refreshAdminSession(req: Request, res: Response, _next: NextFunction) {
  try {
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized", message: "Missing JWT" });
      return;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const refreshedToken = refreshAdminSessionToken(token);
    res.json({ token: refreshedToken, expiresInMinutes: config.adminSessionExpiryMinutes });
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired JWT" });
  }
}

export async function getSecurityHeadersAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const { default: supertest } = await import("supertest");
    const healthResponse = await supertest(req.app).get("/health");

    const headerNames = [
      "x-content-type-options",
      "x-frame-options",
      "content-security-policy",
      "strict-transport-security",
    ];

    const audit = headerNames.map((header) => {
      const value = healthResponse.headers[header] ?? null;
      return {
        header,
        value,
        required: true,
        present: Boolean(value),
      };
    });

    res.json(audit);
  } catch (err) {
    next(err);
  }
}

export async function resetSandboxData(req: Request, res: Response, next: NextFunction) {
  try {
    if (!config.enableSandboxReset) {
      res.status(404).json({ error: "NotFound", message: "Sandbox reset is disabled" });
      return;
    }

    await query("TRUNCATE TABLE indexed_events, yield_snapshots, vault_tvl_snapshots RESTART IDENTITY CASCADE");
    await seed();
    res.json({ success: true, tablesReset: ["indexed_events", "yield_snapshots", "vault_tvl_snapshots"] });
  } catch (err) {
    next(err);
  }
}

export async function getAdminStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const vaultCountRows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM vaults");
    const userCountRows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM users");
    const totalAssetsRows = await query<{ total: string }>("SELECT COALESCE(SUM(total_assets::numeric), 0)::text as total FROM vaults");
    const epochCountRows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM epochs");
    const archiveSizeRows = await query<{ total: string }>(
      "SELECT COALESCE(SUM(pg_total_relation_size(relid)), 0)::text AS total FROM pg_stat_user_tables WHERE relname LIKE '%_archive'",
    );

    const vaultCount = parseInt(vaultCountRows[0]?.count ?? "0", 10);
    const userCount = parseInt(userCountRows[0]?.count ?? "0", 10);
    const totalValueLocked = totalAssetsRows[0]?.total ?? "0";
    const epochCount = parseInt(epochCountRows[0]?.count ?? "0", 10);
    const archiveSizeBytes = parseInt(archiveSizeRows[0]?.total ?? "0", 10);

    res.json({ vaultCount, userCount, totalValueLocked, epochCount, archiveSizeBytes });
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

    await logAdminAudit(req, "backfill_indexer", "/api/v1/admin/indexer/backfill");

    // Persist the backfill range as a pg-boss job so it survives a process
    // restart, instead of the old in-memory queue (#846).
    const jobId = await jobQueue.send("indexer-backfill", { fromLedger, toLedger });

    // Return 202 Accepted immediately
    res.status(202).json({ queued: true, fromLedger, toLedger, jobId });
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
    await logAdminAudit(req, "delete_api_key", `/api/v1/admin/api-keys/${idNum}`);

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
      expires_at: Date | null;
      last_used_at: Date | null;
      active: boolean;
      deactivated_at: Date | null;
      allowed_methods: string[] | null;
      allowed_cidrs: string[] | null;
    }>(
      `SELECT id, label, role, created_at, expires_at, last_used_at, active, deactivated_at,
              allowed_methods, allowed_cidrs
       FROM api_keys ORDER BY created_at DESC`,
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        // null until the key authenticates a request for the first time (#933)
        lastUsedAt: row.last_used_at ?? null,
        // false once the inactivity sweep has retired the key (#934)
        active: row.active,
        deactivatedAt: row.deactivated_at ?? null,
        // null means the key may use any HTTP method (#935)
        allowedMethods: row.allowed_methods ?? null,
        // null means the key may be used from any IP (#928)
        allowedCidrs: row.allowed_cidrs ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateApiKeyDescription(req: Request, res: Response, next: NextFunction) {
  try {
    const keyId = String(req.params["id"]);
    const idNum = parseInt(keyId, 10);

    if (isNaN(idNum) || idNum <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid key ID" });
      return;
    }

    const descriptionSchema = z.object({
      description: z.string().nullable(),
    });

    const parsed = descriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid request body" });
      return;
    }

    const { description } = parsed.data;

    // Check if key exists
    const existingRows = await query<{ id: number }>("SELECT id FROM api_keys WHERE id = $1", [idNum]);

    if (existingRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "API key not found" });
      return;
    }

    // Update only the description field
    await query(
      "UPDATE api_keys SET description = $1 WHERE id = $2",
      [description, idNum],
    );

    // Return the updated key
    const updatedRows = await query<{
      id: number;
      label: string | null;
      role: string;
      created_at: Date;
      expires_at: Date | null;
      description: string | null;
    }>(
      "SELECT id, label, role, created_at, expires_at, description FROM api_keys WHERE id = $1",
      [idNum],
    );

    const updatedKey = updatedRows[0];
    res.json({
      id: updatedKey.id,
      label: updatedKey.label,
      role: updatedKey.role,
      createdAt: updatedKey.created_at,
      expiresAt: updatedKey.expires_at,
      description: updatedKey.description,
    });
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

const bulkToggleWebhooksSchema = z.object({
  ids: z.array(z.string().regex(/^\d+$/, "Each id must be a positive integer")).min(1).max(50),
  active: z.boolean(),
}).strict();

/** POST /admin/webhooks/bulk/toggle — enable/disable up to 50 webhooks in one query (#1006) */
export async function bulkToggleWebhooks(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = bulkToggleWebhooksSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "BadRequest",
        message: "ids must be a non-empty array of at most 50 numeric-string webhook IDs, and active must be a boolean",
        details: parsed.error.issues,
      });
      return;
    }

    const { ids, active } = parsed.data;
    // De-duplicate so the same ID repeated in the request body doesn't
    // inflate the affected-row count reported back to the caller.
    const idNums = [...new Set(ids.map((id) => parseInt(id, 10)))];

    const rows = await query<{ id: number }>(
      "UPDATE webhooks SET active = $1 WHERE id = ANY($2) RETURNING id",
      [active, idNums],
    );

    await logAdminAudit(req, "bulk_toggle_webhooks", "/api/v1/admin/webhooks/bulk/toggle");

    res.json({ updated: rows.length, ids: rows.map((r) => r.id), active });
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

export async function getAdminFeesDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;

    const parsedDateFilters: { column: string; value: string; operator: string }[] = [];
    const dateParams: string[] = [];

    const parseDate = (value: string | undefined, label: "from" | "to") => {
      if (!value) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid ${label} date`);
      }
      return parsed.toISOString();
    };

    const fromDate = parseDate(from, "from");
    const toDate = parseDate(to, "to");

    if (fromDate) {
      parsedDateFilters.push({ column: "ie.created_at", value: fromDate, operator: ">=" });
      dateParams.push(fromDate);
    }
    if (toDate) {
      parsedDateFilters.push({ column: "ie.created_at", value: toDate, operator: "<=" });
      dateParams.push(toDate);
    }

    const dateWhereClause = parsedDateFilters.length > 0
      ? `WHERE ${parsedDateFilters.map((filter, index) => `${filter.column} ${filter.operator} $${index + 1}`).join(" AND ")}`
      : "";
    const dateFilterSuffix = dateWhereClause ? " AND " : " WHERE ";

    const feeSubquery = `SELECT
        ie.contract_id,
        COALESCE(SUM((ie.parsed_data->>'operatorFee')::numeric), 0)::text AS total_operator_fees
      FROM indexed_events ie
      ${dateWhereClause}${dateFilterSuffix}ie.event_type = 'yield_distributed'
      AND ie.parsed_data IS NOT NULL
      GROUP BY ie.contract_id`;

    const lastFeeSubquery = `SELECT ranked.contract_id, ranked.operator_fee
      FROM (
        SELECT
          ie.contract_id,
          COALESCE((ie.parsed_data->>'operatorFee')::text, '0') AS operator_fee,
          row_number() OVER (PARTITION BY ie.contract_id ORDER BY ie.created_at DESC, ie.id DESC) AS rn
        FROM indexed_events ie
        ${dateWhereClause}${dateFilterSuffix}ie.event_type = 'yield_distributed'
        AND ie.parsed_data IS NOT NULL
      ) ranked
      WHERE ranked.rn = 1`;

    const rows = await query<{
      contract_id: string;
      name: string | null;
      fee_bps: number | null;
      total_operator_fees: string;
      epoch_count: string;
      last_epoch_fee: string;
    }>(
      `SELECT
         v.contract_id,
         v.name,
         COALESCE(v.operator_fee_bps, 0) AS fee_bps,
         COALESCE(f.total_operator_fees, '0') AS total_operator_fees,
         COALESCE(e.epoch_count, 0)::text AS epoch_count,
         COALESCE(lf.operator_fee, '0') AS last_epoch_fee
       FROM vaults v
       LEFT JOIN (${feeSubquery}) f ON f.contract_id = v.contract_id
       LEFT JOIN (
         SELECT vault_id, COUNT(*)::text AS epoch_count
         FROM epochs
         GROUP BY vault_id
       ) e ON e.vault_id = v.id
       LEFT JOIN (${lastFeeSubquery}) lf ON lf.contract_id = v.contract_id
       ORDER BY COALESCE(f.total_operator_fees, '0')::numeric DESC`,
      dateParams,
    );

    res.json(rows.map((row) => ({
      contractId: row.contract_id,
      name: row.name,
      totalOperatorFees: row.total_operator_fees,
      epochCount: parseInt(row.epoch_count ?? "0", 10),
      feeBps: row.fee_bps ?? 0,
      lastEpochFee: row.last_epoch_fee ?? "0",
    })));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid ")) {
      res.status(400).json({ error: "BadRequest", message: err.message });
      return;
    }
    next(err);
  }
}

export async function deleteUser(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);

    const existingRows = await query<{ id: number }>("SELECT id FROM users WHERE address = $1", [address]);
    if (existingRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
    }

    const redactedAddress = "[REDACTED]";
    const tables = ["user_vault_positions", "share_balance_snapshots", "redemption_requests"];

    let recordsAffected = 0;
    for (const table of tables) {
      const updated = await query<{ id: number }>(
        `UPDATE ${table} SET user_address = $1 WHERE user_address = $2 RETURNING id`,
        [redactedAddress, address],
      );
      recordsAffected += updated.length;
    }

    // Anonymise historical blockchain events referencing this address, without deleting the events themselves.
    const redactedUserEvents = await query<{ id: number }>(
      `UPDATE indexed_events SET payload = jsonb_set(payload, '{user}', '"[REDACTED]"')
       WHERE payload->>'user' = $1
       RETURNING id`,
      [address],
    );
    recordsAffected += redactedUserEvents.length;

    const redactedAddressEvents = await query<{ id: number }>(
      `UPDATE indexed_events SET payload = jsonb_set(payload, '{address}', '"[REDACTED]"')
       WHERE payload->>'address' = $1
       RETURNING id`,
      [address],
    );
    recordsAffected += redactedAddressEvents.length;

    await query("DELETE FROM users WHERE address = $1", [address]);
    await logAdminAudit(req, "delete_user", `/api/v1/admin/users/${address}`);

    const deletedAt = new Date().toISOString();

    res.json({ address, deletedAt, recordsAffected });
  } catch (err) {
    next(err);
  }
}

export async function getAdminAuditLog(req: Request, res: Response, next: NextFunction) {
  try {
    const rawPage = parseInt(String(req.query["page"] ?? "1"), 10);
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(String(req.query["pageSize"] ?? "20"), 10);
    const pageSize = Math.max(1, Math.min(100, isNaN(rawPageSize) ? 20 : rawPageSize));
    const offset = (page - 1) * pageSize;

    const countRows = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM admin_audit_log");
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const rows = await query<{
      id: number;
      api_key_label: string | null;
      action: string;
      target: string;
      ip_address: string | null;
      request_body_hash: string;
      created_at: Date;
    }>(
      `SELECT id, api_key_label, action, target, ip_address, request_body_hash, created_at
       FROM admin_audit_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );

    res.json({
      data: rows.map((row) => ({
        id: row.id,
        apiKeyLabel: row.api_key_label,
        action: row.action,
        target: row.target,
        ipAddress: row.ip_address,
        requestBodyHash: row.request_body_hash,
        createdAt: row.created_at,
      })),
      total,
      page,
      pageSize,
    });
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

export async function getAdminFees(_req: Request, res: Response, next: NextFunction) {
  try {
    const operatorFeeRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM((parsed_data->>'operatorFee')::numeric), 0)::text AS total
       FROM indexed_events
       WHERE event_type = 'yield_distributed' AND parsed_data IS NOT NULL`,
    );
    const totalOperatorFees = operatorFeeRows[0]?.total ?? "0";

    const redemptionFeeRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM(fee_revenue), 0)::text AS total
       FROM redemption_requests
       WHERE processed = TRUE AND fee_revenue > 0`,
    );
    const totalEarlyRedemptionFees = redemptionFeeRows[0]?.total ?? "0";

    const totalOperatorBig = BigInt(Math.round(parseFloat(totalOperatorFees)));
    const totalRedemptionBig = BigInt(Math.round(parseFloat(totalEarlyRedemptionFees)));
    const totalPlatformRevenue = (totalOperatorBig + totalRedemptionBig).toString();

    const topFeeVaults = await query<{ contract_id: string; total_fees: string }>(
      `SELECT
         ie.contract_id,
         COALESCE(SUM((ie.parsed_data->>'operatorFee')::numeric), 0)::text AS total_fees
       FROM indexed_events ie
       WHERE ie.event_type = 'yield_distributed' AND ie.parsed_data IS NOT NULL
       GROUP BY ie.contract_id
       ORDER BY SUM((ie.parsed_data->>'operatorFee')::numeric) DESC
       LIMIT 5`,
    );

    res.json({
      totalOperatorFees: totalOperatorBig.toString(),
      totalEarlyRedemptionFees: totalRedemptionBig.toString(),
      totalPlatformRevenue,
      topFeeVaults: topFeeVaults.map((v) => ({
        contractId: v.contract_id,
        totalFees: v.total_fees,
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function flagUserAml(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = stellarAddressSchema.safeParse(req.params["address"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid address format" });
      return;
    }
    const address = parsed.data;

    const rows = await query<{ id: number }>(
      "SELECT id FROM users WHERE address = $1",
      [address],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
    }

    await query(
      `UPDATE users SET aml_flagged = TRUE, aml_flagged_at = NOW(), updated_at = NOW()
       WHERE address = $1`,
      [address],
    );

    res.json({ address, amlFlagged: true });
  } catch (err) {
    next(err);
  }
}

export async function clearUserAml(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = stellarAddressSchema.safeParse(req.params["address"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid address format" });
      return;
    }
    const address = parsed.data;

    const rows = await query<{ id: number }>(
      "SELECT id FROM users WHERE address = $1",
      [address],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
    }

    await query(
      `UPDATE users SET aml_flagged = FALSE, aml_flagged_at = NULL, updated_at = NOW()
       WHERE address = $1`,
      [address],
    );

    res.json({ address, amlFlagged: false });
  } catch (err) {
    next(err);
  }
}

export async function getFlaggedUsers(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      address: string;
      aml_flagged_at: Date;
      total_deposited: string;
      kyc_verified: boolean;
    }>(
      `SELECT
         u.address,
         u.aml_flagged_at,
         COALESCE(SUM(uvp.deposited), 0)::text AS total_deposited,
         u.kyc_verified
       FROM users u
       LEFT JOIN user_vault_positions uvp ON uvp.user_address = u.address
       WHERE u.aml_flagged = TRUE
       GROUP BY u.address, u.aml_flagged_at, u.kyc_verified
       ORDER BY u.aml_flagged_at DESC`,
    );

    res.json(
      rows.map((r) => ({
        address: r.address,
        amlFlaggedAt: r.aml_flagged_at,
        totalDeposited: r.total_deposited,
        kycVerified: r.kyc_verified,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function getPositionsSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const asOfParam = req.query["asOf"] as string | undefined;
    const contractIdParam = req.query["contractId"] as string | undefined;
    const formatParam = req.query["format"] as string | undefined;

    if (!asOfParam) {
      res.status(400).json({ error: "BadRequest", message: "asOf query parameter is required (ISO 8601)" });
      return;
    }

    const asOf = new Date(asOfParam);
    if (isNaN(asOf.getTime())) {
      res.status(400).json({ error: "BadRequest", message: "Invalid asOf timestamp" });
      return;
    }

    if (contractIdParam) {
      const cidParsed = contractAddressSchema.safeParse(contractIdParam);
      if (!cidParsed.success) {
        res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
        return;
      }
    }

    const params: unknown[] = [asOf.toISOString()];
    let contractFilter = "";
    if (contractIdParam) {
      params.push(contractIdParam);
      contractFilter = `AND v.contract_id = $${params.length}`;
    }

    const rows = await query<{
      user_address: string;
      vault_contract_id: string;
      shares: string;
      recorded_at: Date;
    }>(
      `SELECT DISTINCT ON (sbs.user_address, sbs.vault_id)
         sbs.user_address,
         v.contract_id AS vault_contract_id,
         sbs.shares::text AS shares,
         sbs.recorded_at
       FROM share_balance_snapshots sbs
       JOIN vaults v ON sbs.vault_id = v.id
       WHERE sbs.recorded_at <= $1
         ${contractFilter}
       ORDER BY sbs.user_address, sbs.vault_id, sbs.epoch DESC`,
      params,
    );

    if (formatParam === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="positions-snapshot-${asOf.toISOString()}.csv"`);
      const header = "user_address,vault_contract_id,shares,recorded_at\n";
      const csvBody = rows
        .map((r) => `${r.user_address},${r.vault_contract_id},${r.shares},${r.recorded_at.toISOString()}`)
        .join("\n");
      res.send(header + csvBody);
      return;
    }

    res.json(
      rows.map((r) => ({
        userAddress: r.user_address,
        vaultContractId: r.vault_contract_id,
        shares: r.shares,
        recordedAt: r.recorded_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/admin/positions/export.csv
 *
 * Streams every user vault position as CSV (#950). Instead of buffering the
 * whole result set in memory (see #430), a pg-cursor is read in batches and
 * piped through a csv-stringify transform straight to the response, so memory
 * use stays flat regardless of row count and the first bytes reach the client
 * as soon as the first batch is read.
 */
const POSITIONS_EXPORT_COLUMNS = [
  "user_address",
  "vault_contract_id",
  "shares",
  "deposited",
  "last_claimed_epoch",
  "updated_at",
] as const;

export async function exportPositionsCsv(_req: Request, res: Response, next: NextFunction) {
  const client = await pool.connect();
  const cursor = client.query(
    new Cursor(
      `SELECT uvp.user_address,
              v.contract_id           AS vault_contract_id,
              uvp.shares::text        AS shares,
              uvp.deposited::text     AS deposited,
              uvp.last_claimed_epoch,
              uvp.updated_at
         FROM user_vault_positions uvp
         JOIN vaults v ON v.id = uvp.vault_id
        ORDER BY uvp.id`,
    ),
  );

  let released = false;
  const cleanup = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await cursor.close();
    } catch {
      /* connection may already be gone */
    }
    client.release();
  };

  const stringifier = stringify({ header: true, columns: [...POSITIONS_EXPORT_COLUMNS] });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="positions-export.csv"');
  res.setHeader("Transfer-Encoding", "chunked");

  stringifier.on("error", (err) => {
    void cleanup();
    res.destroy(err);
  });
  res.on("close", () => {
    void cleanup();
  });
  stringifier.pipe(res);

  try {
    for (;;) {
      const rows = await cursor.read(500);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!stringifier.write(row)) {
          await once(stringifier, "drain");
        }
      }
    }
    stringifier.end();
    await cleanup();
  } catch (err) {
    await cleanup();
    if (!res.headersSent) {
      next(err);
      return;
    }
    res.destroy(err as Error);
  }
}

// ── Issue #803: Vault compliance status ──────────────────────────────────────
export async function getVaultComplianceStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    // Fetch vault fields needed for compliance flags
    const vaultRows = await query<{
      id: number;
      zkme_verifier_address: string | null;
      emergency: boolean;
      paused: boolean;
      document_accessible: boolean | null;
      document_last_checked: Date | null;
    }>(
      `SELECT id, zkme_verifier_address, COALESCE(emergency, FALSE) AS emergency,
              COALESCE(paused, FALSE) AS paused, document_accessible, document_last_checked
       FROM vaults
       WHERE contract_id = $1`,
      [contractId],
    );

    if (vaultRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const vault = vaultRows[0];

    // kycEnforced = zkmeVerifier is set and not the zero address
    const ZERO_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const kycEnforced =
      vault.zkme_verifier_address !== null &&
      vault.zkme_verifier_address !== "" &&
      vault.zkme_verifier_address !== ZERO_ADDRESS;

    // blacklistActive = at least one address is blacklisted for this vault
    const blacklistRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vault_blacklisted_addresses WHERE vault_id = $1`,
      [vault.id],
    );
    const blacklistActive = parseInt(blacklistRows[0]?.count ?? "0", 10) > 0;

    // lastPauseAt: most recent "paused" event for this contract
    const pauseRows = await query<{ created_at: Date }>(
      `SELECT created_at FROM indexed_events
       WHERE contract_id = $1 AND event_type = 'paused'
       ORDER BY created_at DESC
       LIMIT 1`,
      [contractId],
    );
    const lastPauseAt = pauseRows.length > 0 ? pauseRows[0].created_at.toISOString() : null;

    res.json({
      kycEnforced,
      blacklistActive,
      emergency: vault.emergency,
      paused: vault.paused,
      lastPauseAt,
      documentAccessible: vault.document_accessible,
      documentLastChecked: vault.document_last_checked?.toISOString() ?? null,
    });
  } catch (err) {
    next(err);
  }
}

// ── Issue #802: User compliance summary ──────────────────────────────────────
export async function getUserComplianceSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = stellarAddressSchema.safeParse(req.params["address"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid address format" });
      return;
    }
    const address = parsed.data;

    // Fetch basic user fields
    const userRows = await query<{
      kyc_verified: boolean;
      aml_flagged: boolean;
    }>(
      `SELECT kyc_verified, aml_flagged FROM users WHERE address = $1`,
      [address],
    );

    // Defaults for users with no DB record (never interacted via API)
    const kycVerified = userRows[0]?.kyc_verified ?? false;
    const amlFlagged = userRows[0]?.aml_flagged ?? false;

    // Aggregate financials from user_vault_positions
    const financialRows = await query<{
      total_deposited: string;
      vault_count: string;
    }>(
      `SELECT
         COALESCE(SUM(uvp.deposited), 0)::text AS total_deposited,
         COUNT(*)::text AS vault_count
       FROM user_vault_positions uvp
       WHERE uvp.user_address = $1`,
      [address],
    );

    const totalDeposited = financialRows[0]?.total_deposited ?? "0";
    const vaultCount = parseInt(financialRows[0]?.vault_count ?? "0", 10);

    // Total withdrawn: sum of amount_returned from withdraw events
    const withdrawRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM((payload->>'assets')::numeric), 0)::text AS total
       FROM indexed_events
       WHERE event_type = 'withdraw'
         AND payload->>'owner' = $1`,
      [address],
    );
    const totalWithdrawn = withdrawRows[0]?.total ?? "0";

    // Total yield claimed: sum from yield_claim events
    const yieldRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS total
       FROM indexed_events
       WHERE event_type = 'yield_claimed'
         AND payload->>'user' = $1`,
      [address],
    );
    const totalYieldClaimed = yieldRows[0]?.total ?? "0";

    // First and last activity timestamps from indexed_events
    const activityRows = await query<{
      first_activity: Date | null;
      last_activity: Date | null;
    }>(
      `SELECT
         MIN(created_at) AS first_activity,
         MAX(created_at) AS last_activity
       FROM indexed_events
       WHERE payload->>'user' = $1
          OR payload->>'owner' = $1
          OR payload->>'caller' = $1
          OR payload->>'receiver' = $1`,
      [address],
    );

    const firstActivity = activityRows[0]?.first_activity?.toISOString() ?? null;
    const lastActivity = activityRows[0]?.last_activity?.toISOString() ?? null;

    res.json({
      address,
      kycVerified,
      amlFlagged,
      totalDeposited,
      totalWithdrawn,
      totalYieldClaimed,
      vaultCount,
      firstActivity,
      lastActivity,
    });
  } catch (err) {
    next(err);
  }
}

// ── Issue #804: Data retention policy ────────────────────────────────────────
const RETENTION_KEYS = ["eventsRetentionDays", "positionRetentionDays", "auditLogRetentionDays"] as const;
type RetentionKey = (typeof RETENTION_KEYS)[number];

export async function getRetentionPolicy(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key = ANY($1)`,
      [RETENTION_KEYS],
    );

    // Build response, falling back to defaults if a key is missing
    const defaults: Record<RetentionKey, number> = {
      eventsRetentionDays: 90,
      positionRetentionDays: 365,
      auditLogRetentionDays: 365,
    };

    const result = { ...defaults };
    for (const row of rows) {
      if (RETENTION_KEYS.includes(row.key as RetentionKey)) {
        result[row.key as RetentionKey] = parseInt(row.value, 10);
      }
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function patchRetentionPolicy(req: Request, res: Response, next: NextFunction) {
  try {
    const patchSchema = z.object({
      eventsRetentionDays: z.number().int().positive().optional(),
      positionRetentionDays: z.number().int().positive().optional(),
      auditLogRetentionDays: z.number().int().positive().optional(),
    }).strict();

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "BadRequest",
        message: "Values must be positive integers",
        details: parsed.error.issues,
      });
      return;
    }

    const updates = parsed.data;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "BadRequest", message: "No fields provided to update" });
      return;
    }

    // Upsert each supplied key
    for (const [key, value] of Object.entries(updates)) {
      await query(
        `INSERT INTO app_config (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)],
      );
    }

    // Return the full updated policy
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key = ANY($1)`,
      [RETENTION_KEYS],
    );

    const defaults: Record<RetentionKey, number> = {
      eventsRetentionDays: 90,
      positionRetentionDays: 365,
      auditLogRetentionDays: 365,
    };
    const result = { ...defaults };
    for (const row of rows) {
      if (RETENTION_KEYS.includes(row.key as RetentionKey)) {
        result[row.key as RetentionKey] = parseInt(row.value, 10);
      }
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getJobQueueDashboard(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      name: string;
      pending: string;
      active: string;
      failed: string;
      completed24h: string;
    }>(
      `SELECT
         name,
         COUNT(*) FILTER (WHERE state IN ('created', 'retry'))::text AS pending,
         COUNT(*) FILTER (WHERE state = 'active')::text AS active,
         COUNT(*) FILTER (WHERE state = 'failed')::text AS failed,
         COUNT(*) FILTER (WHERE state = 'completed' AND completed_on >= NOW() - INTERVAL '24 hours')::text AS completed24h
       FROM pgboss.job
       GROUP BY name
       ORDER BY name ASC`,
    );

    res.json({
      queues: rows.map((r) => ({
        name: r.name,
        pending: parseInt(r.pending, 10),
        active: parseInt(r.active, 10),
        failed: parseInt(r.failed, 10),
        completed24h: parseInt(r.completed24h, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function getJobStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const jobId = req.params["jobId"] as string;

    const job = await jobQueue.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: "NotFound", message: "Job not found" });
      return;
    }

    let progress: number | null = null;
    if (job.state === "completed") {
      progress = 100;
    } else if (job.output && typeof job.output === "object" && "progress" in job.output) {
      const p = (job.output as Record<string, unknown>)["progress"];
      if (typeof p === "number") {
        progress = p;
      }
    }

    res.json({
      id: job.id,
      name: job.name,
      state: job.state,
      progress,
      createdAt: job.createdOn,
      completedOn: job.completedOn,
      output: job.output,
    });
  } catch (err) {
    next(err);
  }
}

export async function getFailedJobs(_req: Request, res: Response, next: NextFunction) {
  try {
    const jobs = await jobQueue.getFailedJobs(50);

    res.json({
      data: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        payload: job.data,
        createdAt: job.createdOn,
        completedAt: job.completedOn,
        output: job.output,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/** SSE stream of indexer tick progress (#757). */
export function streamIndexerProgress(req: Request, res: Response): void {
  sseManager.addIndexerClient(req, res);
}

/** GET /api/v1/admin/db/slow-queries — retrieve recent slow queries (#963) */
export async function getSlowQueries(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{
      id: number;
      query_hash: string;
      query_preview: string;
      duration_ms: string | number;
      route: string | null;
      occurred_at: Date;
    }>(
      `SELECT id, query_hash, query_preview, duration_ms, route, occurred_at
       FROM slow_query_log
       ORDER BY occurred_at DESC
       LIMIT 50`,
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        query_hash: row.query_hash,
        query_preview: row.query_preview,
        duration_ms: typeof row.duration_ms === "string" ? parseFloat(row.duration_ms) : row.duration_ms,
        route: row.route,
        occurred_at: row.occurred_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

// ── Issue #961: Benchmark reporting ──────────────────────────────────────────

const benchmarkPostSchema = z.object({
  name: z.string().min(1).max(255),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  errorRate: z.number().min(0).max(1),
  timestamp: z.string().datetime(),
}).strict();

export async function postBenchmark(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = benchmarkPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid benchmark payload", details: parsed.error.issues });
      return;
    }

    const { name, p50, p95, p99, errorRate, timestamp } = parsed.data;

    await query(
      `INSERT INTO benchmark_results (name, p50, p95, p99, error_rate, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, p50, p95, p99, errorRate, timestamp],
    );

    await logAdminAudit(req, "post_benchmark", `/api/v1/admin/benchmarks`);

    res.status(201).json({ name, p50, p95, p99, errorRate, timestamp });
  } catch (err) {
    next(err);
  }
}

export async function getBenchmarksByName(req: Request, res: Response, next: NextFunction) {
  try {
    const name = String(req.params["name"]);

    const rows = await query<{
      p50: number;
      p95: number;
      p99: number;
      error_rate: number;
      timestamp: Date;
      created_at: Date;
    }>(
      `SELECT p50, p95, p99, error_rate, timestamp, created_at
       FROM benchmark_results
       WHERE name = $1
       ORDER BY timestamp DESC`,
      [name],
    );

    res.json({
      name,
      results: rows.map((r) => ({
        p50: r.p50,
        p95: r.p95,
        p99: r.p99,
        errorRate: r.error_rate,
        timestamp: r.timestamp,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── Issue #926: Vault archive exclusion toggle ──────────────────────────────
export async function toggleVaultArchiveExclusion(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const bodySchema = z.object({ excludeFromArchive: z.boolean() });
    const bodyParsed = bodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "BadRequest", message: "excludeFromArchive must be a boolean" });
      return;
    }
    const { excludeFromArchive } = bodyParsed.data;

    const rows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    await query(
      "UPDATE vaults SET exclude_from_archive = $1, updated_at = NOW() WHERE contract_id = $2",
      [excludeFromArchive, contractId],
    );

    await logAdminAudit(req, "toggle_vault_archive_exclusion", `/api/v1/admin/vaults/${contractId}/archive-exclusion`);

    res.json({ contractId, excludeFromArchive });
  } catch (err) {
    next(err);
  }
}

// ── Issue #927: Archival verification ────────────────────────────────────────
const ARCHIVABLE_TABLES = ["indexed_events", "share_balance_snapshots", "vault_tvl_snapshots"];

export async function verifyArchiveConsistency(_req: Request, res: Response, next: NextFunction) {
  try {
    const tableResults: {
      name: string;
      liveRows: number;
      archiveRows: number;
      totalRows: number;
      consistent: boolean;
    }[] = [];

    for (const table of ARCHIVABLE_TABLES) {
      const liveRowsResult = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table}`,
      );
      const liveRows = parseInt(liveRowsResult[0]?.count ?? "0", 10);

      const archiveTable = `${table}_archive`;
      let archiveRows = 0;
      try {
        const archiveRowsResult = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${archiveTable}`,
        );
        archiveRows = parseInt(archiveRowsResult[0]?.count ?? "0", 10);
      } catch {
        // Archive table may not exist yet
      }

      const totalRows = liveRows + archiveRows;

      const auditResult = await query<{ pre_archival_count: string }>(
        `SELECT pre_archival_count::text
         FROM archive_audit_log
         WHERE table_name = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [table],
      );

      let consistent = true;
      if (auditResult.length > 0) {
        const preArchivalCount = parseInt(auditResult[0].pre_archival_count, 10);
        consistent = totalRows === preArchivalCount;
      }

      tableResults.push({
        name: table,
        liveRows,
        archiveRows,
        totalRows,
        consistent,
      });
    }

    res.json({ tables: tableResults });
  } catch (err) {
    next(err);
  }
}

// ── Issue #962: Database VACUUM/ANALYZE ──────────────────────────────────────

const APP_TABLES = [
  "vaults", "users", "epochs", "user_vault_positions",
  "indexed_events", "indexer_state", "webhooks", "webhook_deliveries",
  "api_keys", "redemption_requests", "share_balance_snapshots",
  "admin_audit_log", "app_config",
];

const vacuumSchema = z.object({
  tables: z.array(z.string()).optional(),
  analyze: z.boolean(),
}).strict();

export async function vacuumDatabase(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = vacuumSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid payload", details: parsed.error.issues });
      return;
    }

    const targetTables = parsed.data.tables?.length ? parsed.data.tables : APP_TABLES;
    const analyze = parsed.data.analyze;
    const command = analyze ? "VACUUM (ANALYZE)" : "VACUUM";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of targetTables) {
        await client.query(`${command} ${table}`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await logAdminAudit(req, "vacuum_database", "/api/v1/admin/db/vacuum");

    res.json({ ok: true, tables: targetTables, analyze, command });
  } catch (err) {
    next(err);
  }
}
