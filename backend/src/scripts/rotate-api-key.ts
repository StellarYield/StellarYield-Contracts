import "dotenv/config";
import { randomBytes, createHash } from "crypto";
import { pool } from "../db/index.js";
import { logger } from "../logger.js";

/** How long the rotated-out key keeps working when --grace-days is not given (#1246). */
const DEFAULT_GRACE_DAYS = 7;

/** A label may hold at most this many usable keys at once, so a rotation can overlap (#1246). */
const MAX_ACTIVE_KEYS_PER_LABEL = 2;

interface RotationArgs {
  label?: string;
  graceDays: number;
}

interface ActiveKeyRow {
  id: number;
  expires_at: Date | null;
}

function parseArgs(argv: string[]): RotationArgs {
  let label: string | undefined;
  let graceDays = DEFAULT_GRACE_DAYS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label") {
      label = argv[++i];
    } else if (arg === "--grace-days") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--grace-days must be a non-negative whole number of days");
      }
      graceDays = value;
    }
  }

  return { label, graceDays };
}

/**
 * Rotate the newest active key for a label (#1246).
 *
 * A new key is created under the same label with the old key's role, expiry,
 * description and scope, so a rotation never widens or drops restrictions. The
 * old key is not deleted: its expiry is set `graceDays` from now, so clients
 * that have not deployed the new key keep working until it lapses. The label
 * may hold at most two usable keys, so a second rotation waits for the first
 * grace period to end.
 */
async function rotateApiKey(label: string, graceDays: number): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialise rotations for one label, so two concurrent runs cannot both
    // pass the key-count check below.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`api-key-label:${label}`]);

    const { rows: activeKeys } = await client.query<ActiveKeyRow>(
      `SELECT id, expires_at
         FROM api_keys
        WHERE label = $1
          AND active
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC, id DESC
        FOR UPDATE`,
      [label],
    );

    if (activeKeys.length === 0) {
      throw new Error(`No active API key with label "${label}"`);
    }
    if (activeKeys.length >= MAX_ACTIVE_KEYS_PER_LABEL) {
      throw new Error(
        `Label "${label}" already has ${activeKeys.length} active keys. ` +
          "Wait for the grace period to end, or delete one, before rotating again.",
      );
    }

    const oldKey = activeKeys[0];
    const plaintext = randomBytes(32).toString("hex");
    const keyHash = createHash("sha256").update(plaintext).digest("hex");

    const { rows: insertedRows } = await client.query<{ id: number; role: string }>(
      `INSERT INTO api_keys (key_hash, role, label, expires_at, description,
                             allowed_methods, allowed_cidrs, allowed_contract_ids, rate_limit_override)
       SELECT $1, role, label, expires_at, description,
              allowed_methods, allowed_cidrs, allowed_contract_ids, rate_limit_override
         FROM api_keys
        WHERE id = $2
       RETURNING id, role`,
      [keyHash, oldKey.id],
    );
    const newKey = insertedRows[0];

    // LEAST keeps an expiry that was already sooner than the grace period.
    const { rows: updatedRows } = await client.query<{ expires_at: Date }>(
      `UPDATE api_keys
          SET expires_at = LEAST(COALESCE(expires_at, 'infinity'::timestamptz),
                                 NOW() + make_interval(days => $2::int))
        WHERE id = $1
        RETURNING expires_at`,
      [oldKey.id, graceDays],
    );
    const oldKeyExpiresAt = updatedRows[0].expires_at;

    await client.query("COMMIT");

    logger.info(
      {
        label,
        role: newKey.role,
        keyId: newKey.id,
        oldKeyId: oldKey.id,
        graceDays,
        oldKeyExpiresAt: oldKeyExpiresAt.toISOString(),
      },
      "API key rotated; old key remains active during grace period",
    );
    console.log(`\nNew API Key (save this - it won't be shown again):`);
    console.log(`${plaintext}\n`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  let label: string | undefined;
  let graceDays: number;
  try {
    ({ label, graceDays } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    logger.error({ err }, (err as Error).message);
    process.exit(1);
  }

  if (!label) {
    logger.error(
      "Usage: rotate-api-key --label <label> [--grace-days <days>]\n" +
        "Example: rotate-api-key --label my-admin-key --grace-days 14",
    );
    process.exit(1);
  }

  try {
    await rotateApiKey(label, graceDays);
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error(err, "Failed to rotate API key");
    await pool.end();
    process.exit(1);
  }
}

await main();
