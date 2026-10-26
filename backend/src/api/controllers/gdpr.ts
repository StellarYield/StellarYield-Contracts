import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query, pool } from "../../db/index.js";
import { AppError, ErrorCode } from "../middleware/errors.js";
import { stellarAddressSchema } from "../middleware/validate.js";
import { logAdminAudit } from "../../services/adminAuditLog.js";

/**
 * GDPR data subject rights (#1110 export, #1111 erasure).
 *
 * `GET /api/v1/users/:address/data-export` is a ZIP archive for support work;
 * this endpoint is the machine-readable, portable copy required by Art. 20
 * (data portability): one JSON document holding every category of personal
 * data held for the subject, with per-category record counts.
 *
 * Erasure (Art. 17) is deliberately not a blanket `DELETE`. Records that a
 * financial-services retention obligation requires us to keep (positions,
 * balance snapshots, redemptions, fee rebates) are anonymised in place instead
 * of removed, the on-chain event log is redacted, and everything without a
 * retention basis is deleted. Subjects under an AML hold are refused: the
 * regulatory obligation to retain their records overrides the erasure request
 * (Art. 17(3)(b)/(e)) and clearing the hold is an explicit compliance action
 * (`POST /api/v1/admin/users/:address/aml-clear`).
 */

/** Placeholder written in place of an address, mirroring the admin user purge. */
const REDACTED = "[REDACTED]";

const EXPORT_FORMAT = "gdpr-data-export";
const EXPORT_VERSION = 1;

interface SubjectRow {
  id: number;
  address: string;
  kyc_verified: boolean;
  aml_flagged: boolean;
  aml_flagged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function findSubject(address: string): Promise<SubjectRow | null> {
  const rows = await query<SubjectRow>(
    `SELECT id, address, kyc_verified, aml_flagged, aml_flagged_at, created_at, updated_at
     FROM users
     WHERE address = $1
     LIMIT 1`,
    [address],
  );
  return rows[0] ?? null;
}

function subjectAddress(req: Request): string {
  const parsed = stellarAddressSchema.safeParse(req.params["address"]);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid Stellar address", 400);
  }
  return parsed.data;
}

// ── #1110 data export (Art. 15/20) ────────────────────────────────────────────

/**
 * GET /api/v1/gdpr/users/:address/export
 *
 * Returns every category of data held about the subject. NUMERIC columns come
 * back as decimal strings, timestamps as ISO 8601.
 */
export async function exportUserGdprData(req: Request, res: Response, next: NextFunction) {
  try {
    const address = subjectAddress(req);
    const subject = await findSubject(address);

    if (!subject) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
    }

    const [positions, snapshots, redemptions, preferences, roles, rebates, blacklisted, events, archivedEvents] =
      await Promise.all([
        query<{
          contract_id: string;
          shares: string;
          deposited: string;
          last_claimed_epoch: number;
          first_entry_at: Date | null;
          last_exit_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT v.contract_id,
                  uvp.shares::text AS shares,
                  uvp.deposited::text AS deposited,
                  uvp.last_claimed_epoch,
                  uvp.first_entry_at,
                  uvp.last_exit_at,
                  uvp.updated_at
           FROM user_vault_positions uvp
           JOIN vaults v ON v.id = uvp.vault_id
           WHERE uvp.user_address = $1
           ORDER BY uvp.updated_at DESC`,
          [address],
        ),
        query<{
          contract_id: string;
          epoch: number;
          shares: string;
          recorded_at: Date;
        }>(
          `SELECT v.contract_id, sbs.epoch, sbs.shares::text AS shares, sbs.recorded_at
           FROM share_balance_snapshots sbs
           JOIN vaults v ON v.id = sbs.vault_id
           WHERE sbs.user_address = $1
           ORDER BY sbs.epoch DESC`,
          [address],
        ),
        query<{
          contract_id: string;
          shares: string;
          request_time: Date;
          processed: boolean;
          created_at: Date;
        }>(
          `SELECT v.contract_id, rr.shares::text AS shares, rr.request_time, rr.processed, rr.created_at
           FROM redemption_requests rr
           JOIN vaults v ON v.id = rr.vault_id
           WHERE rr.user_address = $1
           ORDER BY rr.request_time DESC`,
          [address],
        ),
        query<{
          event_type: string;
          channel: string;
          enabled: boolean;
          vault_contract_id: string | null;
          updated_at: Date;
        }>(
          `SELECT event_type, channel, enabled, vault_contract_id, updated_at
           FROM user_notification_preferences
           WHERE user_address = $1
           ORDER BY updated_at DESC`,
          [address],
        ),
        query<{ contract_id: string; role: string; granted_at: Date; revoked_at: Date | null }>(
          `SELECT v.contract_id, vr.role, vr.granted_at, vr.revoked_at
           FROM vault_roles vr
           JOIN vaults v ON v.id = vr.vault_id
           WHERE vr.user_address = $1
           ORDER BY vr.granted_at DESC`,
          [address],
        ),
        query<{ contract_id: string; rebate_amount: string; reason: string; tx_hash: string | null; created_at: Date }>(
          `SELECT contract_id, rebate_amount::text AS rebate_amount, reason, tx_hash, created_at
           FROM fee_rebates
           WHERE address = $1
           ORDER BY created_at DESC`,
          [address],
        ),
        query<{ contract_id: string; added_by: string | null; created_at: Date }>(
          `SELECT v.contract_id, vb.added_by, vb.created_at
           FROM vault_blacklisted_addresses vb
           JOIN vaults v ON v.id = vb.vault_id
           WHERE vb.address = $1
           ORDER BY vb.created_at DESC`,
          [address],
        ),
        // Only event types whose payload is stored with a flat 'user'/'address'
        // key are matched; deposit/withdraw payloads keep the raw on-chain
        // event, so they are not retrievable by subject here.
        query<{
          id: number;
          ledger: number;
          tx_hash: string;
          contract_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT id, ledger, tx_hash, contract_id, event_type, payload, created_at
           FROM indexed_events
           WHERE payload->>'user' = $1 OR payload->>'address' = $1
           ORDER BY ledger DESC, tx_index DESC NULLS LAST, event_index DESC NULLS LAST, id DESC`,
          [address],
        ),
        // Events already moved past the retention window; same payload shape.
        query<{
          id: number;
          ledger: number;
          tx_hash: string;
          contract_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT id, ledger, tx_hash, contract_id, event_type, payload, created_at
           FROM indexed_events_archive
           WHERE payload->>'user' = $1 OR payload->>'address' = $1
           ORDER BY created_at DESC`,
          [address],
        ),
      ]);

    await logAdminAudit(req, "gdpr_export", `/api/v1/gdpr/users/${address}/export`);

    res.json({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      subject: {
        address: subject.address,
        kycVerified: subject.kyc_verified,
        amlFlagged: subject.aml_flagged,
        amlFlaggedAt: subject.aml_flagged_at,
        createdAt: subject.created_at,
        updatedAt: subject.updated_at,
      },
      recordCounts: {
        positions: positions.length,
        shareBalanceSnapshots: snapshots.length,
        redemptionRequests: redemptions.length,
        notificationPreferences: preferences.length,
        vaultRoles: roles.length,
        feeRebates: rebates.length,
        blacklistedAddresses: blacklisted.length,
        events: events.length,
        archivedEvents: archivedEvents.length,
      },
      data: {
        positions: positions.map((row) => ({
          contractId: row.contract_id,
          shares: row.shares,
          deposited: row.deposited,
          lastClaimedEpoch: row.last_claimed_epoch,
          firstEntryAt: row.first_entry_at,
          lastExitAt: row.last_exit_at,
          updatedAt: row.updated_at,
        })),
        shareBalanceSnapshots: snapshots.map((row) => ({
          contractId: row.contract_id,
          epoch: row.epoch,
          shares: row.shares,
          recordedAt: row.recorded_at,
        })),
        redemptionRequests: redemptions.map((row) => ({
          contractId: row.contract_id,
          shares: row.shares,
          requestTime: row.request_time,
          processed: row.processed,
          createdAt: row.created_at,
        })),
        notificationPreferences: preferences.map((row) => ({
          eventType: row.event_type,
          channel: row.channel,
          enabled: row.enabled,
          vaultContractId: row.vault_contract_id,
          updatedAt: row.updated_at,
        })),
        vaultRoles: roles.map((row) => ({
          contractId: row.contract_id,
          role: row.role,
          grantedAt: row.granted_at,
          revokedAt: row.revoked_at,
        })),
        feeRebates: rebates.map((row) => ({
          contractId: row.contract_id,
          rebateAmount: row.rebate_amount,
          reason: row.reason,
          txHash: row.tx_hash,
          createdAt: row.created_at,
        })),
        blacklistedAddresses: blacklisted.map((row) => ({
          contractId: row.contract_id,
          addedBy: row.added_by,
          createdAt: row.created_at,
        })),
        events: events.map((row) => ({
          id: row.id,
          ledger: row.ledger,
          txHash: row.tx_hash,
          contractId: row.contract_id,
          eventType: row.event_type,
          payload: row.payload,
          createdAt: row.created_at,
        })),
        archivedEvents: archivedEvents.map((row) => ({
          id: row.id,
          ledger: row.ledger,
          txHash: row.tx_hash,
          contractId: row.contract_id,
          eventType: row.event_type,
          payload: row.payload,
          createdAt: row.created_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── #1111 erasure (Art. 17) ───────────────────────────────────────────────────

/**
 * Query flags. Unlike the repository-wide `z.coerce.boolean()` (any non-empty
 * string is true), these parse explicitly so `?confirm=false` can never erase
 * anything.
 */
export const gdprErasureQuerySchema = z.object({
  dryRun: z.enum(["true", "false", "1", "0"]).optional().default("false"),
  confirm: z.enum(["true", "false", "1", "0"]).optional().default("false"),
});

const isTrue = (value: string | undefined): boolean => value === "true" || value === "1";

/** Query values are strings once `validateQuery` has parsed them. */
const queryFlag = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Per-category row counts, used both for the dry run and the applied report. */
interface ErasurePlan {
  positions: number;
  shareBalanceSnapshots: number;
  redemptionRequests: number;
  notificationPreferences: number;
  vaultRoles: number;
  feeRebates: number;
  blacklistedAddresses: number;
  events: number;
  archivedEvents: number;
}

/**
 * Redacts both keys the indexer stores a subject under, in one statement so a
 * row carrying both counts once. Events pruned past the retention window live
 * in `indexed_events_archive` with the same payload, so they are redacted too.
 */
const eventRedaction = (table: string): string =>
  `UPDATE ${table}
      SET payload = jsonb_set(jsonb_set(payload, '{user}', '"[REDACTED]"'), '{address}', '"[REDACTED]"')
    WHERE payload->>'user' = $1 OR payload->>'address' = $1`;

async function loadErasurePlan(address: string): Promise<ErasurePlan> {
  // Aliases are quoted so Postgres returns them camelCased: an unquoted alias is
  // folded to lower case, and the counts are read back by camelCase key.
  const rows = await query<ErasurePlan>(
    `SELECT
       (SELECT COUNT(*) FROM user_vault_positions WHERE user_address = $1) AS "positions",
       (SELECT COUNT(*) FROM share_balance_snapshots WHERE user_address = $1) AS "shareBalanceSnapshots",
       (SELECT COUNT(*) FROM redemption_requests WHERE user_address = $1) AS "redemptionRequests",
       (SELECT COUNT(*) FROM user_notification_preferences WHERE user_address = $1) AS "notificationPreferences",
       (SELECT COUNT(*) FROM vault_roles WHERE user_address = $1) AS "vaultRoles",
       (SELECT COUNT(*) FROM fee_rebates WHERE address = $1) AS "feeRebates",
       (SELECT COUNT(*) FROM vault_blacklisted_addresses WHERE address = $1) AS "blacklistedAddresses",
       (SELECT COUNT(*) FROM indexed_events WHERE payload->>'user' = $1 OR payload->>'address' = $1) AS "events",
       (SELECT COUNT(*) FROM indexed_events_archive WHERE payload->>'user' = $1 OR payload->>'address' = $1) AS "archivedEvents"`,
    [address],
  );
  return (
    rows[0] ?? {
      positions: 0,
      shareBalanceSnapshots: 0,
      redemptionRequests: 0,
      notificationPreferences: 0,
      vaultRoles: 0,
      feeRebates: 0,
      blacklistedAddresses: 0,
      events: 0,
      archivedEvents: 0,
    }
  );
}

/**
 * Static statements, applied in one transaction. Financial records are
 * anonymised in place (retention), everything else is deleted. `params` binds
 * the redaction placeholder only where the statement actually references it —
 * Postgres rejects a bind message carrying more parameters than the statement
 * uses.
 */
const ERASURE_STATEMENTS: ReadonlyArray<{
  key: keyof ErasurePlan;
  mode: "erased" | "anonymized";
  sql: string;
  params: (address: string) => unknown[];
}> = [
  { key: "notificationPreferences", mode: "erased", sql: "DELETE FROM user_notification_preferences WHERE user_address = $1", params: (address) => [address] },
  { key: "blacklistedAddresses", mode: "erased", sql: "DELETE FROM vault_blacklisted_addresses WHERE address = $1", params: (address) => [address] },
  { key: "positions", mode: "anonymized", sql: "UPDATE user_vault_positions SET user_address = $1 WHERE user_address = $2", params: (address) => [REDACTED, address] },
  { key: "shareBalanceSnapshots", mode: "anonymized", sql: "UPDATE share_balance_snapshots SET user_address = $1 WHERE user_address = $2", params: (address) => [REDACTED, address] },
  { key: "redemptionRequests", mode: "anonymized", sql: "UPDATE redemption_requests SET user_address = $1 WHERE user_address = $2", params: (address) => [REDACTED, address] },
  { key: "vaultRoles", mode: "anonymized", sql: "UPDATE vault_roles SET user_address = $1 WHERE user_address = $2", params: (address) => [REDACTED, address] },
  { key: "feeRebates", mode: "anonymized", sql: "UPDATE fee_rebates SET address = $1 WHERE address = $2", params: (address) => [REDACTED, address] },
  { key: "events", mode: "anonymized", sql: eventRedaction("indexed_events"), params: (address) => [address] },
  { key: "archivedEvents", mode: "anonymized", sql: eventRedaction("indexed_events_archive"), params: (address) => [address] },
];

/** Splits a plan into the two buckets the endpoint reports on. */
function projectPlan(plan: ErasurePlan): { erased: Record<string, number>; anonymized: Record<string, number> } {
  const erased: Record<string, number> = { profile: 1 };
  const anonymized: Record<string, number> = {};
  for (const statement of ERASURE_STATEMENTS) {
    const bucket = statement.mode === "erased" ? erased : anonymized;
    bucket[statement.key] = plan[statement.key];
  }
  return { erased, anonymized };
}

/**
 * DELETE /api/v1/gdpr/users/:address
 *
 * `?dryRun=true` reports what would happen without writing anything.
 * `?confirm=true` applies it. Without either flag the request is rejected.
 *
 * All writes share one transaction, so a failure part-way through leaves the
 * subject untouched and surfaces as a 500. The `[REDACTED]` placeholder is the
 * same one the existing admin `DELETE /admin/users/:address` uses, so a subject
 * whose rows would collide with an existing `[REDACTED]` row (the UNIQUE keys on
 * `user_vault_positions`, `share_balance_snapshots` and `vault_roles` are keyed on
 * the address) fails the transaction rather than merging the two subjects'
 * records. That trade-off is deliberate: merging would corrupt another
 * subject's balances.
 */
export async function deleteUserGdprData(req: Request, res: Response, next: NextFunction) {
  try {
    const address = subjectAddress(req);
    const subject = await findSubject(address);

    if (!subject) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
    }

    if (subject.aml_flagged) {
      res.status(409).json({
        error: "Conflict",
        message: "Erasure blocked: the subject is under an active AML hold and their records must be retained",
        amlFlaggedAt: subject.aml_flagged_at,
      });
      return;
    }

    const plan = await loadErasurePlan(address);
    const dryRun = isTrue(queryFlag(req.query["dryRun"]));

    if (dryRun) {
      await logAdminAudit(req, "gdpr_erasure_dry_run", `/api/v1/gdpr/users/${address}`);
      res.json({ address, mode: "dry-run", ...projectPlan(plan) });
      return;
    }

    if (!isTrue(queryFlag(req.query["confirm"]))) {
      res.status(400).json({
        error: "BadRequest",
        message: "Erasure is irreversible: re-run with ?dryRun=true to preview it, or ?confirm=true to apply it",
      });
      return;
    }

    const erased: Record<string, number> = { profile: 0 };
    const anonymized: Record<string, number> = {};

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const statement of ERASURE_STATEMENTS) {
        const result = await client.query(statement.sql, statement.params(address));
        const target = statement.mode === "erased" ? erased : anonymized;
        target[statement.key] = result.rowCount ?? 0;
      }

      const deleted = await client.query("DELETE FROM users WHERE address = $1", [address]);
      erased["profile"] = deleted.rowCount ?? 0;

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await logAdminAudit(req, "gdpr_erasure", `/api/v1/gdpr/users/${address}`);

    res.json({
      address,
      mode: "applied",
      erasedAt: new Date().toISOString(),
      erased,
      anonymized,
      retentionNote:
        "Financial records (positions, balance snapshots, redemptions, roles, fee rebates) were " +
        "anonymised rather than deleted to satisfy record-keeping obligations; indexed on-chain " +
        "events, including those already past the retention window, were redacted in place. " +
        "The subject no longer has a user record.",
    });
  } catch (err) {
    next(err);
  }
}
