import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request, Response, NextFunction } from "express";
import Cursor from "pg-cursor";
import { stringify } from "csv-stringify";
import { z } from "zod";
import { query, pool } from "../../db/index.js";
import { config } from "../../config.js";
import { seed } from "../../db/seed.js";
import { indexer } from "../../services/indexerSingleton.js";
import { KNOWN_EVENT_TYPES } from "../../services/indexerEventTypes.js";
import { EpochAnomalyService } from "../../services/epochAnomaly.js";
import { jobQueue } from "../../services/jobQueue.js";
import { findApiKeysExpiringWithin, type ApiKeyListRow } from "../../services/apiKeyExpiryReminder.js";
import { sseManager } from "../../services/sseManager.js";
import { logger } from "../../logger.js";
import { createAdminSessionToken, INVALID_CREDENTIALS_RESPONSE, refreshAdminSessionToken } from "../middleware/auth.js";
import { getApiKeyUsage } from "../../cache/redis.js";
import { logAdminAudit } from "../../services/adminAuditLog.js";
import { logSecurityEvent } from "../../services/securityLogger.js";
import { generateWebhookSecret, secretRotationWindowHours } from "../../services/webhookSignature.js";
import { setPaginationLinks } from "../middleware/paginationLinks.js";

const OPENAPI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../openapi");

export async function getApiDiff(req: Request, res: Response, next: NextFunction) {
  try {
    const from = String(req.query["from"] ?? "");
    const to = String(req.query["to"] ?? "");
    if (!from || !to) {
      res.status(400).json({
        error: "BadRequest",
        message: "Both 'from' and 'to' query parameters are required",
      });
      return;
    }
    if (!(["v1", "v2"] as const).includes(from as "v1" | "v2") || !(["v1", "v2"] as const).includes(to as "v1" | "v2")) {
      res.status(400).json({
        error: "BadRequest",
        message: "Invalid version. Only 'v1' and 'v2' are supported",
      });
      return;
    }

    const fromSpec = JSON.parse(readFileSync(resolve(OPENAPI_DIR, `${from}.json`), "utf8")) as { paths: Record<string, unknown> };
    const toSpec = JSON.parse(readFileSync(resolve(OPENAPI_DIR, `${to}.json`), "utf8")) as { paths: Record<string, unknown> };
    const fromPaths = fromSpec.paths ?? {};
    const toPaths = toSpec.paths ?? {};
    const added = Object.keys(toPaths).filter((path) => !(path in fromPaths));
    const removed = Object.keys(fromPaths).filter((path) => !(path in toPaths));
    const modified = Object.keys(fromPaths).filter(
      (path) => path in toPaths && JSON.stringify(fromPaths[path]) !== JSON.stringify(toPaths[path]),
    );

    res.json({ from, to, added, removed, modified });
  } catch (err) {
    next(err);
  }
}

export async function getApiKeyUsageStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "BadRequest", message: "API key id must be a positive integer" });
      return;
    }
    res.json(await getApiKeyUsage(id));
  } catch (err) {
    next(err);
  }
}

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

    // Unknown, deactivated and expired keys all get the same 401 body and each
    // records a security event, so the response and its timing do not reveal
    // which case applied (#1247). The lifecycle checks run before the role
    // check, so the 403 below only ever answers a key that is live.
    const apiKey = await findApiKeyByValue(parsed.data.apiKey);
    if (!apiKey) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: req.ip ?? null, path: req.path, details: { reason: "key_not_found" } });
      res.status(401).json(INVALID_CREDENTIALS_RESPONSE);
      return;
    }

    // A session must never outlive the key it is minted from, so the same
    // lifecycle checks the auth middleware applies run here too (#934).
    if (!apiKey.active) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: req.ip ?? null, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "deactivated" } });
      res.status(401).json(INVALID_CREDENTIALS_RESPONSE);
      return;
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: req.ip ?? null, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "expired" } });
      res.status(401).json(INVALID_CREDENTIALS_RESPONSE);
      return;
    }

    if (apiKey.role !== "admin") {
      res.status(403).json({ error: "Forbidden", message: "Admin API key required" });
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
    // Factory WASM hash from the most recent indexed update event (#837).
    const wasmRows = await query<{ new_hash: string }>(
      "SELECT new_hash FROM factory_wasm_history ORDER BY recorded_at DESC, id DESC LIMIT 1",
    );

    const vaultCount = parseInt(vaultCountRows[0]?.count ?? "0", 10);
    const userCount = parseInt(userCountRows[0]?.count ?? "0", 10);
    const totalValueLocked = totalAssetsRows[0]?.total ?? "0";
    const epochCount = parseInt(epochCountRows[0]?.count ?? "0", 10);
    const archiveSizeBytes = parseInt(archiveSizeRows[0]?.total ?? "0", 10);
    // Null until the first wasm_upd event has been indexed.
    const wasmHash = wasmRows[0]?.new_hash ?? null;

    res.json({ vaultCount, userCount, totalValueLocked, epochCount, archiveSizeBytes, wasmHash });
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

    res.json({
      running,
      lastLedger,
      lastTickAt,
      eventsIndexed,
      // #1213: current adaptive ledger batch size.
      batchSize: indexer.getBatchSize(),
    });
  } catch (err) {
    next(err);
  }
}

export async function getIndexerDeadLetters(req: Request, res: Response, next: NextFunction) {
  try {
    const rawLimit = parseInt(String(req.query["limit"] ?? "50"), 10);
    const limit = Math.max(1, Math.min(200, Number.isNaN(rawLimit) ? 50 : rawLimit));
    const rawOffset = parseInt(String(req.query["offset"] ?? "0"), 10);
    const offset = Math.max(0, Number.isNaN(rawOffset) ? 0 : rawOffset);

    const [rows, countRows] = await Promise.all([
      query(
        `SELECT id, contract_id, ledger, raw_event, error_message, created_at
         FROM indexer_dead_letters
         ORDER BY created_at DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      query<{ count: string }>("SELECT COUNT(*)::text AS count FROM indexer_dead_letters"),
    ]);

    res.json({
      data: rows,
      total: parseInt(countRows[0]?.count ?? "0", 10),
      limit,
      offset,
    });
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

// ── Per-contract indexer controls (#1106, #1107) ──────────────────────────────

const indexerContractIdSchema = z.string().regex(/^C[A-Z2-7]{55}$/);

export const eventFilterBodySchema = z.object({
  allowedTypes: z
    .array(z.string().trim().min(1))
    .max(64)
    .refine((types) => types.every((t) => KNOWN_EVENT_TYPES.has(t)), {
      message: "allowedTypes contains an unknown event type",
    }),
});

interface IndexerContractStateRow {
  contract_id: string;
  indexing_paused: boolean;
  allowed_event_types: string[] | null;
  updated_at: Date | string;
}

function formatIndexerContractState(row: IndexerContractStateRow) {
  return {
    contractId: row.contract_id,
    indexingPaused: row.indexing_paused,
    allowedTypes: row.allowed_event_types ?? [],
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Resolves `:contractId` to a contract the indexer knows about (a vault or the
 * factory). Sends the 400/404 response itself and returns null on failure.
 */
async function resolveIndexedContract(req: Request, res: Response): Promise<string | null> {
  const parsed = indexerContractIdSchema.safeParse(req.params["contractId"]);
  if (!parsed.success) {
    res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
    return null;
  }
  const contractId = parsed.data;
  if (contractId === config.stellar.vaultFactoryContractId) return contractId;

  const rows = await query<{ id: number }>("SELECT id FROM vaults WHERE contract_id = $1", [contractId]);
  if (rows.length === 0) {
    res.status(404).json({ error: "NotFound", message: `Contract ${contractId} is not indexed` });
    return null;
  }
  return contractId;
}

/**
 * POST /api/v1/admin/indexer/:contractId/pause (#1107)
 *
 * Skips the contract in every polling cycle. Records the global indexer ledger
 * at pause time so a later resume can replay the events missed while paused.
 * Pausing an already-paused contract keeps the original ledger.
 */
export async function pauseContractIndexing(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = await resolveIndexedContract(req, res);
    if (!contractId) return;

    const rows = await query<IndexerContractStateRow>(
      `INSERT INTO indexer_contract_state (contract_id, indexing_paused, paused_at_ledger)
       VALUES ($1, TRUE, (SELECT last_ledger FROM indexer_state ORDER BY id LIMIT 1))
       ON CONFLICT (contract_id) DO UPDATE
         SET indexing_paused = TRUE,
             paused_at_ledger = COALESCE(indexer_contract_state.paused_at_ledger, EXCLUDED.paused_at_ledger),
             updated_at = NOW()
       RETURNING contract_id, indexing_paused, allowed_event_types, updated_at`,
      [contractId],
    );
    await logAdminAudit(req, "pause_contract_indexing", `/api/v1/admin/indexer/${contractId}/pause`);

    res.json(formatIndexerContractState(rows[0]));
  } catch (err) {
    next(err);
  }
}

// ── Issue #1105: indexer start-block configuration ────────────────────────────

/**
 * GET /api/v1/admin/indexer/start-block
 *
 * The block a fresh indexing run starts from, plus the current cursor. The
 * start block is stored in `indexer_state.start_ledger`; when that column is
 * NULL the `INDEXER_START_LEDGER` env var is the fallback (`source:
 * "environment"`). `active` is false once the cursor has advanced, because the
 * start block is only consulted while no progress has been recorded.
 */
export async function getIndexerStartBlock(_req: Request, res: Response, next: NextFunction) {
  try {
    const [{ startBlock, source }, lastLedger] = await Promise.all([
      indexer.getStartLedgerConfig(),
      indexer.getLastIndexedLedger(),
    ]);

    res.json({
      startBlock,
      source,
      envStartLedger: config.indexer.startLedger,
      lastLedger,
      running: indexer.isRunning(),
      active: lastLedger === 0,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/admin/indexer/:contractId/resume (#1107)
 *
 * Re-enables indexing. `paused_at_ledger` is left in place: the indexer's next
 * cycle replays the contract from that ledger up to the current cursor and
 * then clears it, so indexing continues from the last known ledger.
 */
export async function resumeContractIndexing(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = await resolveIndexedContract(req, res);
    if (!contractId) return;

    const rows = await query<IndexerContractStateRow>(
      `INSERT INTO indexer_contract_state (contract_id, indexing_paused)
       VALUES ($1, FALSE)
       ON CONFLICT (contract_id) DO UPDATE
         SET indexing_paused = FALSE, updated_at = NOW()
       RETURNING contract_id, indexing_paused, allowed_event_types, updated_at`,
      [contractId],
    );
    await logAdminAudit(req, "resume_contract_indexing", `/api/v1/admin/indexer/${contractId}/resume`);

    res.json(formatIndexerContractState(rows[0]));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/indexer/:contractId/event-filter (#1106)
 *
 * Body: { allowedTypes: string[] }. Only the listed event types are indexed for
 * the contract from the next index run; `[]` removes the filter. Types may be
 * stored event types (`deposit`, `yield_distributed`) or topic symbols.
 */
export async function setContractEventFilter(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = eventFilterBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "BadRequest",
        message: parsed.error.issues[0]?.message ?? "Invalid request body",
      });
      return;
    }
    const contractId = await resolveIndexedContract(req, res);
    if (!contractId) return;

    const allowedTypes = Array.from(new Set(parsed.data.allowedTypes));
    const rows = await query<IndexerContractStateRow>(
      `INSERT INTO indexer_contract_state (contract_id, allowed_event_types)
       VALUES ($1, $2::text[])
       ON CONFLICT (contract_id) DO UPDATE
         SET allowed_event_types = EXCLUDED.allowed_event_types, updated_at = NOW()
       RETURNING contract_id, indexing_paused, allowed_event_types, updated_at`,
      [contractId, allowedTypes],
    );
    await logAdminAudit(req, "set_contract_event_filter", `/api/v1/admin/indexer/${contractId}/event-filter`);

    res.json(formatIndexerContractState(rows[0]));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/v1/admin/indexer/start-block
 *
 * Body: `{ "startBlock": <ledger> }`. Persists the origin of a fresh indexing
 * run. A start block ahead of the current cursor is rejected: it would skip
 * every ledger between the two. The value takes effect on the next indexer
 * start, never mid-run, so the cursor is left untouched.
 */
export async function updateIndexerStartBlock(req: Request, res: Response, next: NextFunction) {
  try {
    const startBlockSchema = z.object({
      startBlock: z.number().int().min(0),
    }).strict();

    const parsed = startBlockSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "BadRequest",
        message: "startBlock must be a non-negative integer",
        details: parsed.error.issues,
      });
      return;
    }

    const { startBlock } = parsed.data;
    const lastLedger = await indexer.getLastIndexedLedger();

    if (startBlock > lastLedger) {
      res.status(400).json({
        error: "BadRequest",
        message: `startBlock must not be ahead of the current indexer cursor (${lastLedger})`,
      });
      return;
    }

    await indexer.saveStartLedgerConfig(startBlock);
    await logAdminAudit(req, "update_indexer_start_block", "/api/v1/admin/indexer/start-block");

    res.json({
      startBlock,
      source: "database",
      envStartLedger: config.indexer.startLedger,
      lastLedger,
      running: indexer.isRunning(),
      active: lastLedger === 0,
    });
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

// Optional window for the expiring-keys listing (#1245). Bounded so a caller
// cannot ask for an unbounded scan; the daily reminder uses 7 days.
const expiringWithinDaysSchema = z.coerce.number().int().min(1).max(365);

export async function getApiKeys(req: Request, res: Response, next: NextFunction) {
  try {
    const rawWindow = req.query?.["expiringWithinDays"];

    let rows: ApiKeyListRow[];
    if (rawWindow === undefined) {
      rows = await query<ApiKeyListRow>(
        `SELECT id, label, role, description, created_at, expires_at, last_used_at, active, deactivated_at,
                allowed_methods, allowed_cidrs, allowed_contract_ids
         FROM api_keys ORDER BY created_at DESC`,
      );
    } else {
      const parsed = expiringWithinDaysSchema.safeParse(rawWindow);
      if (!parsed.success) {
        res.status(400).json({
          error: "BadRequest",
          message: "expiringWithinDays must be an integer between 1 and 365",
        });
        return;
      }
      rows = await findApiKeysExpiringWithin(parsed.data);
    }

    res.json(
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        role: row.role,
        description: row.description ?? null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        // null until the key authenticates a request for the first time (#933)
        ...(row.last_used_at !== undefined ? { lastUsedAt: row.last_used_at ?? null } : {}),
        // false once the inactivity sweep has retired the key (#934)
        ...(row.active !== undefined ? { active: row.active } : {}),
        ...(row.deactivated_at !== undefined ? { deactivatedAt: row.deactivated_at ?? null } : {}),
        // null means the key may use any HTTP method (#935)
        ...(row.allowed_methods !== undefined ? { allowedMethods: row.allowed_methods ?? null } : {}),
        // null means the key may be used from any IP (#928)
        ...(row.allowed_cidrs !== undefined ? { allowedCidrs: row.allowed_cidrs ?? null } : {}),
        // null means the key may access every vault (#1243)
        ...(row.allowed_contract_ids !== undefined ? { allowedContractIds: row.allowed_contract_ids ?? null } : {}),
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
      status: string;
      delivered_at: Date | null;
      last_error: string | null;
      next_retry_at: Date | null;
      replayed_from: number | null;
      created_at: Date;
    }>(
      `SELECT id, attempt, status, delivered_at, last_error, next_retry_at, replayed_from, created_at
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
        status: r.status,
        deliveredAt: r.delivered_at,
        lastError: r.last_error,
        nextRetryAt: r.next_retry_at,
        replayedFrom: r.replayed_from,
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

/**
 * POST /admin/webhooks/:id/circuit-reset (#1061)
 *
 * Closes an open circuit so deliveries resume on the next triggered event.
 * Also clears the failure counter that opened it, otherwise the very next
 * failure would immediately re-trip the breaker.
 */
export async function resetWebhookCircuit(req: Request, res: Response, next: NextFunction) {
  try {
    const webhookId = parseInt(req.params["id"] as string, 10);
    if (isNaN(webhookId) || webhookId <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid webhook ID" });
      return;
    }

    const rows = await query<{ id: number; circuit_open: boolean }>(
      `UPDATE webhooks
          SET circuit_open = FALSE, circuit_opened_at = NULL, consecutive_failures = 0
        WHERE id = $1
        RETURNING id, circuit_open`,
      [webhookId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Webhook not found" });
      return;
    }

    await logAdminAudit(req, "webhook_circuit_reset", `/api/v1/admin/webhooks/${webhookId}/circuit-reset`);

    res.json({ id: webhookId, circuitOpen: false, consecutiveFailures: 0 });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/webhooks/:id/rotate-secret (#1062)
 *
 * Issues a fresh HMAC secret and keeps the outgoing one valid for
 * SECRET_ROTATION_WINDOW_HOURS so receivers can roll over without downtime.
 * The new secret is returned once; neither secret is ever readable again.
 */
export async function rotateWebhookSecret(req: Request, res: Response, next: NextFunction) {
  try {
    const webhookId = parseInt(req.params["id"] as string, 10);
    if (isNaN(webhookId) || webhookId <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid webhook ID" });
      return;
    }

    const newSecret = generateWebhookSecret();
    const windowHours = secretRotationWindowHours();

    const rows = await query<{ id: number; had_secret: boolean }>(
      `UPDATE webhooks
          SET previous_secret = secret,
              secret = $1,
              secret_rotated_at = NOW()
        WHERE id = $2
        RETURNING id, previous_secret IS NOT NULL AS had_secret`,
      [newSecret, webhookId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Webhook not found" });
      return;
    }

    await logAdminAudit(req, "webhook_rotate_secret", `/api/v1/admin/webhooks/${webhookId}/rotate-secret`);

    res.json({
      id: webhookId,
      secret: newSecret,
      rotationWindowHours: windowHours,
      previousSecretRetained: rows[0].had_secret,
      rotatesAt: new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/webhooks/deliveries/:deliveryId/replay (#1063)
 *
 * Re-enqueues a past delivery verbatim from the delivery log, without
 * re-indexing the underlying event. The clone is a new row that references
 * the source via `replayed_from`.
 */
export async function replayWebhookDelivery(req: Request, res: Response, next: NextFunction) {
  try {
    const deliveryId = parseInt(req.params["deliveryId"] as string, 10);
    if (isNaN(deliveryId) || deliveryId <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid delivery ID" });
      return;
    }

    const source = await query<{
      id: number;
      webhook_id: number;
      payload: string;
      circuit_open: boolean;
      active: boolean;
    }>(
      `SELECT wd.id, wd.webhook_id, wd.payload::text AS payload,
              w.circuit_open, w.active
         FROM webhook_deliveries wd
         JOIN webhooks w ON w.id = wd.webhook_id
        WHERE wd.id = $1`,
      [deliveryId],
    );
    if (source.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Delivery not found" });
      return;
    }

    const original = source[0];
    if (original.circuit_open) {
      res.status(409).json({
        error: "Conflict",
        message:
          "Webhook circuit is open; reset it before replaying deliveries for this endpoint",
      });
      return;
    }

    const inserted = await query<{ id: number }>(
      `INSERT INTO webhook_deliveries
         (webhook_id, payload, attempt, next_retry_at, replayed_from, status)
       VALUES ($1, $2, 1, NOW(), $3, 'pending')
       RETURNING id`,
      [original.webhook_id, original.payload, original.id],
    );

    await jobQueue.send("webhook-deliver", {
      webhookId: original.webhook_id,
      payload: original.payload,
      deliveryId: inserted[0].id,
    });

    await logAdminAudit(
      req,
      "webhook_replay_delivery",
      `/api/v1/admin/webhooks/deliveries/${deliveryId}/replay`,
    );

    res.status(201).json({
      deliveryId: inserted[0].id,
      replayedFrom: original.id,
      webhookId: original.webhook_id,
      status: "queued",
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
    // Issue #918: reads from the live table only; archived is always false for
    // live events. Events moved to indexed_events_archive are not included here.
    const rows = await query<{
      id: number;
      ledger: number;
      tx_hash: string;
      contract_id: string;
      event_type: string;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT id, ledger, tx_hash, contract_id, event_type, payload, created_at
       FROM indexed_events
       ${whereClause}
       ORDER BY ledger DESC, tx_index DESC NULLS LAST, event_index DESC NULLS LAST, id DESC
       LIMIT 50`,
      params,
    );

    res.json(rows.map((row) => ({ ...row, archived: false })));
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

interface AuditLogFilters {
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
}

function buildAuditLogFilters(filters: AuditLogFilters, startIdx = 0): {
  conditions: string[];
  params: any[];
  nextIdx: number;
} {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = startIdx;

  if (filters.action && filters.action.trim() !== "") {
    idx++;
    conditions.push(`action = $${idx}`);
    params.push(filters.action.trim());
  }

  if (filters.actor && filters.actor.trim() !== "") {
    idx++;
    conditions.push(`api_key_label = $${idx}`);
    params.push(filters.actor.trim());
  }

  if (filters.from && filters.from.trim() !== "") {
    idx++;
    conditions.push(`created_at >= $${idx}::timestamptz`);
    params.push(filters.from.trim());
  }

  if (filters.to && filters.to.trim() !== "") {
    idx++;
    conditions.push(`created_at <= $${idx}::timestamptz`);
    params.push(filters.to.trim());
  }

  return { conditions, params, nextIdx: idx };
}

function decodeAuditCursor(cursorStr: string): { cursorId: number | null; cursorCreatedAt: Date | null } {
  try {
    const raw = Buffer.from(cursorStr, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    const cursorId = typeof parsed.id === "number" ? parsed.id : null;
    const cursorCreatedAt = parsed.created_at ? new Date(parsed.created_at) : null;
    if (cursorId !== null) {
      return { cursorId, cursorCreatedAt };
    }
  } catch {
    // not base64url JSON
  }
  const idNum = parseInt(cursorStr, 10);
  if (!isNaN(idNum)) {
    return { cursorId: idNum, cursorCreatedAt: null };
  }
  return { cursorId: null, cursorCreatedAt: null };
}

function encodeAuditCursor(id: number, createdAt: Date): string {
  return Buffer.from(
    JSON.stringify({
      id,
      created_at: createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString(),
    }),
  ).toString("base64url");
}

export async function getAdminAuditLog(req: Request, res: Response, next: NextFunction) {
  try {
    const action = typeof req.query["action"] === "string" ? req.query["action"] : undefined;
    const actor = typeof req.query["actor"] === "string" ? req.query["actor"] : undefined;
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const cursorParam = typeof req.query["cursor"] === "string" && req.query["cursor"].trim() !== ""
      ? req.query["cursor"].trim()
      : undefined;

    const rawLimit = parseInt(String(req.query["limit"] ?? req.query["pageSize"] ?? "20"), 10);
    const limit = Math.max(1, Math.min(100, isNaN(rawLimit) ? 20 : rawLimit));

    const { conditions, params, nextIdx } = buildAuditLogFilters({ action, actor, from, to });
    let paramIdx = nextIdx;

    const countWhere = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM admin_audit_log ${countWhere}`,
      params,
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const queryConditions = [...conditions];
    const queryParams = [...params];

    if (cursorParam) {
      const { cursorId, cursorCreatedAt } = decodeAuditCursor(cursorParam);
      if (cursorCreatedAt !== null && cursorId !== null) {
        paramIdx++;
        queryConditions.push(`(created_at, id) < ($${paramIdx}::timestamptz, $${paramIdx + 1})`);
        queryParams.push(cursorCreatedAt.toISOString(), cursorId);
        paramIdx++;
      } else if (cursorId !== null) {
        paramIdx++;
        queryConditions.push(`id < $${paramIdx}`);
        queryParams.push(cursorId);
      }

      const whereClause = queryConditions.length > 0 ? `WHERE ${queryConditions.join(" AND ")}` : "";
      paramIdx++;
      queryParams.push(limit + 1);

      const rows = await query<{
        id: number;
        api_key_label: string | null;
        action: string;
        target: string;
        ip_address: string | null;
        request_body_hash: string;
        details: any;
        created_at: Date;
      }>(
        `SELECT id, api_key_label, action, target, ip_address, request_body_hash, details, created_at
         FROM admin_audit_log
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT $${paramIdx}`,
        queryParams,
      );

      let nextCursor: string | null = null;
      if (rows.length > limit) {
        rows.pop();
        const lastRow = rows[rows.length - 1];
        nextCursor = encodeAuditCursor(lastRow.id, lastRow.created_at);
      }

      if (nextCursor) {
        res.set("X-Next-Cursor", nextCursor);
      }
      setPaginationLinks(res, req, { nextCursor });

      res.json({
        data: rows.map((row) => ({
          id: row.id,
          apiKeyLabel: row.api_key_label,
          actor: row.api_key_label,
          action: row.action,
          target: row.target,
          ipAddress: row.ip_address,
          requestBodyHash: row.request_body_hash,
          details: row.details ?? null,
          createdAt: row.created_at,
        })),
        nextCursor,
        total,
        limit,
        pageSize: limit,
      });
      return;
    }

    const rawPage = parseInt(String(req.query["page"] ?? "1"), 10);
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
    const offset = (page - 1) * limit;

    const whereClause = queryConditions.length > 0 ? `WHERE ${queryConditions.join(" AND ")}` : "";
    queryParams.push(limit + 1);
    const limitIdx = queryParams.length;
    queryParams.push(offset);
    const offsetIdx = queryParams.length;

    const rows = await query<{
      id: number;
      api_key_label: string | null;
      action: string;
      target: string;
      ip_address: string | null;
      request_body_hash: string;
      details: any;
      created_at: Date;
    }>(
      `SELECT id, api_key_label, action, target, ip_address, request_body_hash, details, created_at
       FROM admin_audit_log
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      queryParams,
    );

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows.pop();
      const lastRow = rows[rows.length - 1];
      nextCursor = encodeAuditCursor(lastRow.id, lastRow.created_at);
    }

    if (nextCursor) {
      res.set("X-Next-Cursor", nextCursor);
    }
    setPaginationLinks(res, req, { nextCursor });

    res.json({
      data: rows.map((row) => ({
        id: row.id,
        apiKeyLabel: row.api_key_label,
        actor: row.api_key_label,
        action: row.action,
        target: row.target,
        ipAddress: row.ip_address,
        requestBodyHash: row.request_body_hash,
        details: row.details ?? null,
        createdAt: row.created_at,
      })),
      nextCursor,
      total,
      page,
      pageSize: limit,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

const AUDIT_LOG_EXPORT_COLUMNS = [
  "timestamp",
  "actor",
  "action",
  "target",
  "details",
] as const;

export async function exportAdminAuditLogCsv(req: Request, res: Response, next: NextFunction) {
  const action = typeof req.query["action"] === "string" ? req.query["action"] : undefined;
  const actor = typeof req.query["actor"] === "string" ? req.query["actor"] : undefined;
  const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
  const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;

  const { conditions, params } = buildAuditLogFilters({ action, actor, from, to });
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let client: any;
  try {
    client = await pool.connect();
  } catch (err) {
    next(err);
    return;
  }

  const cursor = client.query(
    new Cursor(
      `SELECT created_at,
              api_key_label AS actor,
              action,
              target,
              details
         FROM admin_audit_log
        ${whereClause}
        ORDER BY created_at DESC, id DESC`,
      params,
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

  const stringifier = stringify({ header: true, columns: [...AUDIT_LOG_EXPORT_COLUMNS] });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
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
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        const timestamp = row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at ? new Date(row.created_at).toISOString() : "";
        const formattedRow = {
          timestamp,
          actor: row.actor ?? "",
          action: row.action ?? "",
          target: row.target ?? "",
          details: row.details != null
            ? (typeof row.details === "object" ? JSON.stringify(row.details) : String(row.details))
            : "",
        };
        if (!stringifier.write(formattedRow)) {
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

export async function getVaultNotes(req: Request, res: Response, next: NextFunction) {
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
      res.status(404).json({ error: "NotFound", message: `Vault ${contractId} not found` });
      return;
    }

    const rows = await query<{
      id: number;
      contract_id: string;
      author: string;
      note: string;
      created_at: Date;
    }>(
      `SELECT id, contract_id, author, note, created_at
         FROM vault_admin_notes
        WHERE contract_id = $1
        ORDER BY created_at DESC, id DESC`,
      [contractId],
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        contractId: r.contract_id,
        author: r.author,
        note: r.note,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function createVaultNote(req: Request, res: Response, next: NextFunction) {
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
      res.status(404).json({ error: "NotFound", message: `Vault ${contractId} not found` });
      return;
    }

    const { note, author } = (req.body ?? {}) as { note?: unknown; author?: unknown };
    if (typeof note !== "string" || note.trim().length === 0) {
      res.status(400).json({ error: "BadRequest", message: "Note is required and cannot be empty" });
      return;
    }

    const noteAuthor =
      typeof author === "string" && author.trim().length > 0
        ? author.trim()
        : req.apiKey?.label ?? "admin";

    const rows = await query<{
      id: number;
      contract_id: string;
      author: string;
      note: string;
      created_at: Date;
    }>(
      `INSERT INTO vault_admin_notes (contract_id, author, note, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, contract_id, author, note, created_at`,
      [contractId, noteAuthor, note.trim()],
    );

    await logAdminAudit(req, "create_vault_note", `/api/v1/admin/vaults/${contractId}/notes`);

    const created = rows[0];
    res.status(201).json({
      id: created.id,
      contractId: created.contract_id,
      author: created.author,
      note: created.note,
      createdAt: created.created_at,
    });
  } catch (err) {
    next(err);
  }
}

export async function getVaultTags(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const rows = await query<{ tags: string[] | null }>(
      "SELECT tags FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: `Vault ${contractId} not found` });
      return;
    }

    res.json({
      contractId,
      tags: rows[0].tags ?? [],
    });
  } catch (err) {
    next(err);
  }
}

export async function updateVaultTags(req: Request, res: Response, next: NextFunction) {
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
      res.status(404).json({ error: "NotFound", message: `Vault ${contractId} not found` });
      return;
    }

    const rawTags = Array.isArray(req.body)
      ? req.body
      : req.body?.tags;

    if (!Array.isArray(rawTags)) {
      res.status(422).json({
        error: "UnprocessableEntity",
        message: "tags must be an array of strings",
      });
      return;
    }

    if (rawTags.length > 10) {
      res.status(422).json({
        error: "UnprocessableEntity",
        message: "A vault may have at most 10 tags",
      });
      return;
    }

    const normalizedTags: string[] = [];
    for (const tag of rawTags) {
      if (typeof tag !== "string") {
        res.status(422).json({
          error: "UnprocessableEntity",
          message: "Each tag must be a string",
        });
        return;
      }
      const trimmed = tag.trim();
      if (trimmed.length === 0 || trimmed.length > 32) {
        res.status(422).json({
          error: "UnprocessableEntity",
          message: "Tag length must be between 1 and 32 characters",
        });
        return;
      }
      if (!/^[a-z0-9_-]+$/i.test(trimmed)) {
        res.status(422).json({
          error: "UnprocessableEntity",
          message: `Invalid tag characters in "${trimmed}". Tags may only contain alphanumeric characters, hyphens, and underscores.`,
        });
        return;
      }
      normalizedTags.push(trimmed.toLowerCase());
    }

    const updateRows = await query<{ tags: string[] }>(
      "UPDATE vaults SET tags = $1 WHERE contract_id = $2 RETURNING tags",
      [normalizedTags, contractId],
    );

    await logAdminAudit(req, "update_vault_tags", `/api/v1/admin/vaults/${contractId}/tags`);

    res.json({
      contractId,
      tags: updateRows[0]?.tags ?? normalizedTags,
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


// Issue #1108: indexer event count per contract
export async function getIndexerEventCounts(_req: Request, res: Response, next: NextFunction) {
  try {
    const counts = await indexer.getEventCountsPerContract();
    res.json(counts);
  } catch (err) {
    next(err);
  }
}

export const quarterlyReportQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  quarter: z.coerce.number().int().min(1).max(4),
});

// Issue #1114: quarterly yield report
export async function getQuarterlyYieldReport(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = quarterlyReportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid year or quarter parameter (quarter must be 1, 2, 3, or 4)" });
      return;
    }

    const { year, quarter } = parsed.data;

    // Define quarter date ranges in UTC
    const quarterStarts: Record<number, string> = {
      1: `${year}-01-01T00:00:00.000Z`,
      2: `${year}-04-01T00:00:00.000Z`,
      3: `${year}-07-01T00:00:00.000Z`,
      4: `${year}-10-01T00:00:00.000Z`,
    };
    const quarterEnds: Record<number, string> = {
      1: `${year}-04-01T00:00:00.000Z`,
      2: `${year}-07-01T00:00:00.000Z`,
      3: `${year}-10-01T00:00:00.000Z`,
      4: `${year + 1}-01-01T00:00:00.000Z`,
    };

    const start = quarterStarts[quarter];
    const end = quarterEnds[quarter];

    // totalYieldPaid: sum of finalized epoch yields in the quarter
    const yieldRows = await query<{ total_yield: string }>(
      `SELECT COALESCE(SUM(yield_amount), 0)::text AS total_yield
       FROM epochs
       WHERE (closed_at >= $1 AND closed_at < $2)
          OR (closed_at IS NULL AND distributed_at >= $1 AND distributed_at < $2)`,
      [start, end],
    );
    const totalYieldPaid = yieldRows[0]?.total_yield ?? "0";

    // totalFeesEarned: fees collected across all vaults in the quarter
    let totalFeesEarned = "0";
    try {
      const feeRows = await query<{ total_fees: string }>(
        `SELECT COALESCE(SUM(fee_amount), 0)::text AS total_fees
         FROM transfer_fees
         WHERE collected_at >= $1 AND collected_at < $2`,
        [start, end],
      );
      totalFeesEarned = feeRows[0]?.total_fees ?? "0";
    } catch {
      totalFeesEarned = "0";
    }

    // peakTvlUsd: maximum single-day TVL snapshot in the quarter
    const tvlRows = await query<{ peak_tvl: string }>(
      `WITH daily AS (
         SELECT date_trunc('day', recorded_at) AS day,
                SUM(total_assets) AS daily_assets
         FROM vault_tvl_snapshots
         WHERE recorded_at >= $1 AND recorded_at < $2
         GROUP BY date_trunc('day', recorded_at)
       )
       SELECT COALESCE(MAX(daily_assets), 0)::text AS peak_tvl
       FROM daily`,
      [start, end],
    );
    let peakTvlUsd = tvlRows[0]?.peak_tvl ?? "0";
    if (peakTvlUsd === "0") {
      const fallbackTvl = await query<{ max_assets: string }>(
        `SELECT COALESCE(MAX(total_assets), 0)::text AS max_assets
         FROM vault_tvl_snapshots
         WHERE recorded_at >= $1 AND recorded_at < $2`,
        [start, end],
      );
      peakTvlUsd = fallbackTvl[0]?.max_assets ?? "0";
    }

    // uniqueHolders: count of distinct holders with active shares
    const holderRows = await query<{ count: string }>(
      `SELECT COUNT(DISTINCT user_address)::text AS count
       FROM user_vault_positions
       WHERE shares > 0`,
    );
    const uniqueHolders = parseInt(holderRows[0]?.count ?? "0", 10);

    res.json({
      year,
      quarter,
      totalYieldPaid,
      totalFeesEarned,
      peakTvlUsd,
      uniqueHolders,
    });
  } catch (err) {
    next(err);
  }
}

// ── Issues #1077, #1078: Transfer Alerts ───────────────────────────────────────

interface TransferAlertRow {
  id: number;
  vault_id: number | null;
  contract_id: string | null;
  type: string;
  amount: string | null;
  from_address: string | null;
  to_address: string | null;
  tx_hash: string | null;
  details: Record<string, unknown> | null;
  created_at: Date;
  acknowledged_at: Date | null;
}

/**
 * GET /api/v1/admin/transfer-alerts
 * Lists transfer alerts. By default, returns unacknowledged alerts.
 */
export async function getTransferAlerts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { acknowledged, status } = req.query as { acknowledged?: string; status?: string };

    let whereClause = "WHERE acknowledged_at IS NULL";
    if (acknowledged === "true" || status === "acknowledged") {
      whereClause = "WHERE acknowledged_at IS NOT NULL";
    } else if (acknowledged === "all" || status === "all") {
      whereClause = "";
    }

    const rows = await query<TransferAlertRow>(
      `SELECT id, vault_id, contract_id, type, amount, from_address, to_address, tx_hash, details, created_at, acknowledged_at
       FROM transfer_alerts
       ${whereClause}
       ORDER BY created_at DESC`,
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        vaultId: row.vault_id,
        contractId: row.contract_id,
        type: row.type,
        amount: row.amount ? String(row.amount) : null,
        fromAddress: row.from_address,
        toAddress: row.to_address,
        txHash: row.tx_hash,
        details: row.details,
        createdAt: row.created_at,
        acknowledgedAt: row.acknowledged_at,
      })),
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/admin/vaults/:contractId/epoch-anomalies (#1073)
 *
 * Lists the epochs whose yield sat far from that vault's own recent history, so
 * an operator can tell a genuine change in the underlying asset apart from an
 * indexing fault. Read-only: detection runs on its own schedule and this
 * endpoint only reports what it found.
 */
export async function getEpochAnomalies(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }

    // Newest epoch first, so the most recent flag is at the top of the response.
    const rawLimit = parseInt(String(req.query["limit"] ?? "100"), 10);
    const limit = Math.max(1, Math.min(500, isNaN(rawLimit) ? 100 : rawLimit));

    const anomalies = await new EpochAnomalyService().listForVault(parsed.data, limit);
    res.json(anomalies);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/transfer-alerts/:id/acknowledge
 * Marks a transfer alert as acknowledged.
 */
export async function acknowledgeTransferAlert(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid alert id" });
      return;
    }

    const rows = await query<TransferAlertRow>(
      `UPDATE transfer_alerts
       SET acknowledged_at = NOW()
       WHERE id = $1
       RETURNING id, vault_id, contract_id, type, amount, from_address, to_address, tx_hash, details, created_at, acknowledged_at`,
      [id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Transfer alert not found" });
      return;
    }

    const row = rows[0];
    res.json({
      id: row.id,
      vaultId: row.vault_id,
      contractId: row.contract_id,
      type: row.type,
      amount: row.amount ? String(row.amount) : null,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      txHash: row.tx_hash,
      details: row.details,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
    });
  } catch (err) {
    next(err);
  }
}

// --- #1088 Admin CSV export for all vaults ----------------------------------------

/**
 * GET /api/v1/admin/reports/vaults.csv
 *
 * Streamed CSV export of all active and paused vaults with current metrics.
 * Columns: contractId, name, status, tvlUsd, totalShares, latestApy, holderCount
 */
export async function exportVaultsCsv(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await query<{
      contract_id: string;
      name: string;
      status: string;
      tvl_usd: string | number;
      total_shares: string | number;
      latest_apy: string | number | null;
      holder_count: string | number;
    }>(
      `SELECT v.contract_id, v.name, v.status,
              COALESCE(v.tvl_usd, 0) AS tvl_usd,
              COALESCE(v.total_shares, 0) AS total_shares,
              v.latest_apy,
              COALESCE(h.holder_count, 0) AS holder_count
       FROM vaults v
       LEFT JOIN (
         SELECT vault_id, COUNT(DISTINCT user_address) AS holder_count
         FROM user_vault_positions
         WHERE shares > 0
         GROUP BY vault_id
       ) h ON h.vault_id = v.id
       WHERE v.status IN ('active', 'paused')
       ORDER BY v.name ASC`,
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="vaults.csv"');

    const csvStream = stringify({
      header: true,
      columns: ["contractId", "name", "status", "tvlUsd", "totalShares", "latestApy", "holderCount"],
    });

    csvStream.pipe(res);

    for (const row of rows) {
      csvStream.write([
        row.contract_id,
        row.name,
        row.status,
        row.tvl_usd,
        row.total_shares,
        row.latest_apy ?? "",
        row.holder_count,
      ]);
    }

    csvStream.end();
  } catch (err) {
    next(err);
  }
}

// ── Admin Watchlist (#1284) ──────────────────────────────────────────────
export async function getAdminWatchlist(req: Request, res: Response, next: NextFunction) {
  try {
    const adminKeyId = req.apiKey?.id;
    if (!adminKeyId) {
      res.status(401).json({ error: "Unauthorized", message: "Admin key required" });
      return;
    }
    const rows = await query<{
      contract_id: string;
      added_at: Date;
      name: string | null;
      symbol: string | null;
      status: string | null;
      tvl: string | null;
    }>(
      `SELECT w.contract_id, w.added_at, v.name, v.symbol, v.state AS status, v.total_assets AS tvl
       FROM admin_watchlist w
       LEFT JOIN vaults v ON w.contract_id = v.contract_id
       WHERE w.admin_key_id = $1
       ORDER BY w.added_at DESC`,
      [adminKeyId],
    );
    res.json({
      watchlist: rows.map((r) => ({
        contractId: r.contract_id,
        addedAt: r.added_at,
        name: r.name,
        symbol: r.symbol,
        status: r.status,
        tvl: r.tvl ?? "0",
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function addToAdminWatchlist(req: Request, res: Response, next: NextFunction) {
  try {
    const adminKeyId = req.apiKey?.id;
    if (!adminKeyId) {
      res.status(401).json({ error: "Unauthorized", message: "Admin key required" });
      return;
    }
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    await query(
      `INSERT INTO admin_watchlist (admin_key_id, contract_id, added_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (admin_key_id, contract_id) DO NOTHING`,
      [adminKeyId, contractId],
    );

    await logAdminAudit(req, "add_watchlist", `/api/v1/admin/watchlist/${contractId}`);

    res.json({ success: true, contractId });
  } catch (err) {
    next(err);
  }
}

export async function removeFromAdminWatchlist(req: Request, res: Response, next: NextFunction) {
  try {
    const adminKeyId = req.apiKey?.id;
    if (!adminKeyId) {
      res.status(401).json({ error: "Unauthorized", message: "Admin key required" });
      return;
    }
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    await query(
      "DELETE FROM admin_watchlist WHERE admin_key_id = $1 AND contract_id = $2",
      [adminKeyId, contractId],
    );

    await logAdminAudit(req, "remove_watchlist", `/api/v1/admin/watchlist/${contractId}`);

    res.json({ success: true, contractId });
  } catch (err) {
    next(err);
  }
}

// ── Admin Vault Unlisted Flag (#1285) ────────────────────────────────────────
export async function toggleVaultUnlisted(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    const unlisted = typeof req.body?.unlisted === "boolean" ? req.body.unlisted : true;

    const result = await query<{ contract_id: string; unlisted: boolean }>(
      "UPDATE vaults SET unlisted = $1, updated_at = NOW() WHERE contract_id = $2 RETURNING contract_id, unlisted",
      [unlisted, contractId],
    );

    if (result.length === 0) {
      res.status(404).json({ error: "NotFound", message: `Vault ${contractId} not found` });
      return;
    }

    await cacheDel(`vault:${contractId}*`);
    await cacheDel("vaults:list:*");

    await logAdminAudit(req, "toggle_vault_unlisted", `/api/v1/admin/vaults/${contractId}/unlisted`);

    res.json({ success: true, contractId, unlisted: result[0].unlisted });
  } catch (err) {
    next(err);
  }
}

// ── Admin Featured Vault Ordering (#1286) ──────────────────────────────────
export async function setVaultFeaturedRank(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractAddressSchema.safeParse(req.params["contractId"]);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid contractId format" });
      return;
    }
    const contractId = parsed.data;

    let featuredRank: number | null = null;
    if (req.body?.featuredRank !== null && req.body?.featuredRank !== undefined) {
      const parsedRank = Number(req.body.featuredRank);
      if (!Number.isInteger(parsedRank) || parsedRank < 0) {
        res.status(400).json({ error: "BadRequest", message: "featuredRank must be a non-negative integer or null" });
        return;
      }
      featuredRank = parsedRank;
    }

    const result = await query<{ contract_id: string; featured_rank: number | null }>(
      "UPDATE vaults SET featured_rank = $1, updated_at = NOW() WHERE contract_id = $2 RETURNING contract_id, featured_rank",
      [featuredRank, contractId],
    );

    if (result.length === 0) {
      res.status(404).json({ error: "NotFound", message: `Vault ${contractId} not found` });
      return;
    }

    await cacheDel(`vault:${contractId}*`);
    await cacheDel("vaults:list:*");

    await logAdminAudit(req, "set_vault_featured_rank", `/api/v1/admin/vaults/${contractId}/featured-rank`);

    res.json({ success: true, contractId, featuredRank: result[0].featured_rank });
  } catch (err) {
    next(err);
  }
}

