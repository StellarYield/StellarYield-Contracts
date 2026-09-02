import { query } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface DeactivatedKeyRow {
  id: number;
  label: string | null;
  last_used_at: Date | null;
  created_at: Date;
}

/**
 * Deactivate API keys that have been idle for longer than
 * `KEY_INACTIVITY_DAYS` (#934).
 *
 * A key that has never authenticated is measured from `created_at` instead of
 * `last_used_at`, so keys that are issued and then forgotten are cleaned up on
 * the same schedule. Deactivation is reversible by an operator (`active` back
 * to TRUE); the sweep never deletes a key.
 *
 * Returns the number of keys deactivated. When `KEY_INACTIVITY_DAYS` is unset
 * the sweep is a no-op, which is the default so existing deployments keep
 * their current behaviour.
 */
export async function deactivateInactiveApiKeys(): Promise<number> {
  const days = config.apiKeyInactivityDays;

  if (days === null) {
    logger.debug("KEY_INACTIVITY_DAYS is unset; skipping API key inactivity sweep");
    return 0;
  }

  // `make_interval` keeps the threshold a bound parameter rather than
  // interpolated SQL.
  const rows = await query<DeactivatedKeyRow>(
    `UPDATE api_keys
        SET active = FALSE, deactivated_at = NOW()
      WHERE active
        AND COALESCE(last_used_at, created_at) < NOW() - make_interval(days => $1::int)
      RETURNING id, label, last_used_at, created_at`,
    [days],
  );

  for (const row of rows) {
    logger.warn(
      {
        event: "api_key_deactivated",
        keyId: row.id,
        keyLabel: row.label,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        inactivityDays: days,
        reason: row.last_used_at === null ? "never_used" : "inactive",
      },
      "API key deactivated after inactivity",
    );
  }

  if (rows.length > 0) {
    logger.info({ deactivated: rows.length, inactivityDays: days }, "API key inactivity sweep complete");
  }

  return rows.length;
}
