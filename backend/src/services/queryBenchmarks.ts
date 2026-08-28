import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Issue #964 — query performance regression detection.
//
// After each deployment (detected via a change in the `DEPLOY_ID` env var) we
// run the "hot" queries (the ones that back the most-trafficked endpoints)
// against the database and record their durations in `query_benchmarks`.
// `compareBenchmarks` then computes the per-query regression between a base and
// a head deploy so a PR that slows a query down by > 20% is flagged.
// ─────────────────────────────────────────────────────────────────────────────

export interface HotQuery {
  name: string;
  sql: string;
}

/**
 * The hot queries benchmarked on every deploy. Each corresponds to a real,
 * frequently-hit endpoint so a regression here is a user-visible regression.
 */
export const HOT_QUERIES: HotQuery[] = [
  {
    name: "vault_list",
    sql: `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
                v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
                v.created_at, v.updated_at, v.funding_target, v.funding_deadline,
                v.min_deposit, v.max_deposit_per_user, v.rwa_name, v.rwa_symbol,
                v.rwa_document_uri, v.rwa_category, v.description, v.logo_uri
         FROM vaults v
         WHERE v.archived = FALSE
         ORDER BY v.created_at DESC
         LIMIT 20`,
  },
  {
    name: "vault_detail",
    sql: `SELECT v.* FROM vaults v WHERE v.contract_id = $1`,
  },
  {
    name: "depositor_count",
    sql: `SELECT COUNT(*)::int AS depositor_count
          FROM user_vault_positions uvp
          WHERE uvp.shares > 0`,
  },
  {
    name: "vault_tvl_latest",
    sql: `SELECT total_assets, total_supply
          FROM vault_tvl_snapshots
          ORDER BY recorded_at DESC
          LIMIT 1`,
  },
  {
    name: "yield_distributions",
    sql: `SELECT e.epoch, e.yield_amount, e.total_shares, e.distributed_at
          FROM epochs e
          ORDER BY e.epoch DESC
          LIMIT 50`,
  },
  {
    name: "top_holders",
    sql: `SELECT uvp.user_address, uvp.shares
          FROM user_vault_positions uvp
          JOIN vaults v ON v.id = uvp.vault_id
          WHERE v.archived = FALSE
          ORDER BY uvp.shares DESC
          LIMIT 20`,
  },
  {
    name: "vault_search",
    sql: `SELECT v.id, v.contract_id, v.name, v.symbol
          FROM vaults v
          WHERE v.archived = FALSE
            AND v.search_vector @@ plainto_tsquery('english', $1)
          LIMIT 20`,
  },
  {
    name: "recent_events",
    sql: `SELECT id, ledger, contract_id, event_type, created_at
          FROM indexed_events
          ORDER BY created_at DESC
          LIMIT 50`,
  },
  {
    name: "vault_count_by_state",
    sql: `SELECT state, COUNT(*)::int AS count
          FROM vaults
          WHERE archived = FALSE
          GROUP BY state`,
  },
  {
    name: "metadata_history",
    sql: `SELECT h.field, h.old_value, h.new_value, h.recorded_at
          FROM vault_metadata_history h
          ORDER BY h.recorded_at DESC
          LIMIT 50`,
  },
];

/**
 * Run a single SQL statement once and return its duration in milliseconds.
 * Load-bearing fast paths only need one execution; we keep it lightweight.
 */
async function measureQuery(name: string, sql: string, params?: unknown[]): Promise<number> {
  const start = performance.now();
  await query(sql, params ?? []);
  return performance.now() - start;
}

/**
 * Provide stable, realistic bind parameters for the parameterised hot queries so
 * they exercise the same plan shape a real request would.
 */
function benchQueryParams(name: string): unknown[] | undefined {
  switch (name) {
    case "vault_detail":
      // Any well-formed contract-ish id works — the query just resolves to no rows.
      return ["CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3BMNOP"];
    case "vault_search":
      return ["vault"];
    default:
      return undefined;
  }
}

/**
 * Benchmark every hot query and record the durations for a given deploy id.
 * Returns `false` when benchmarks for that deploy already exist (idempotent).
 */
export async function benchDeploy(deployId: string): Promise<boolean> {
  const existing = await query<{ id: number }>(
    "SELECT id FROM query_benchmarks WHERE deploy_id = $1 LIMIT 1",
    [deployId],
  );
  if (existing.length > 0) return false;

  for (const hot of HOT_QUERIES) {
    try {
      const params = benchQueryParams(hot.name);
      const durationMs = await measureQuery(hot.name, hot.sql, params);
      await query(
        `INSERT INTO query_benchmarks (deploy_id, query_name, duration_ms)
         VALUES ($1, $2, $3)`,
        [deployId, hot.name, Math.round(durationMs * 100) / 100],
      );
    } catch (err) {
      logger.warn({ err, queryName: hot.name }, "Benchmark query failed; recording null duration");
      await query(
        `INSERT INTO query_benchmarks (deploy_id, query_name, duration_ms)
         VALUES ($1, $2, $3)`,
        [deployId, hot.name, -1],
      );
    }
  }

  logger.info({ deployId, queryCount: HOT_QUERIES.length }, "Recorded query benchmarks for deploy");
  return true;
}

/**
 * Run benchmarks once per deployment on startup. Detects a new deploy by the
 * `DEPLOY_ID` env var: if benchmarks for the current id are absent, we record
 * them. Safe to call on every boot — it is a no-op for an already-benchmarked id.
 */
export async function runDeploymentBenchmarksIfNeeded(): Promise<void> {
  if (!config.deployId) {
    logger.debug("DEPLOY_ID not set; skipping deployment benchmarks");
    return;
  }
  try {
    await benchDeploy(config.deployId);
  } catch (err) {
    logger.error({ err }, "Failed to record deployment query benchmarks");
  }
}

export interface BenchmarkComparison {
  query: string;
  baseDuration: number;
  headDuration: number;
  regressionPct: number;
  isRegression: boolean;
}

/** Flag any query whose head duration is > 20% worse than base. */
export const REGRESSION_THRESHOLD_PCT = 20;

/**
 * Compare benchmark records between two deploys, one row per query.
 * Queries missing on either side are included with a `null`-safe 0 duration.
 */
export async function compareBenchmarks(
  baseDeployId: string,
  headDeployId: string,
): Promise<BenchmarkComparison[]> {
  const rows = await query<{
    query: string;
    base_duration: number | null;
    head_duration: number | null;
  }>(
    `SELECT
       COALESCE(b.query_name, h.query_name) AS query,
       b.duration_ms AS base_duration,
       h.duration_ms AS head_duration
     FROM query_benchmarks b
     FULL JOIN query_benchmarks h
       ON b.query_name = h.query_name
      AND b.deploy_id = $1
      AND h.deploy_id = $2
     WHERE b.deploy_id = $1 OR h.deploy_id = $2
     ORDER BY COALESCE(b.query_name, h.query_name)`,
    [baseDeployId, headDeployId],
  );

  return rows.map((r) => {
    const baseDuration = r.base_duration == null || r.base_duration < 0 ? 0 : r.base_duration;
    const headDuration = r.head_duration == null || r.head_duration < 0 ? 0 : r.head_duration;
    let regressionPct = 0;
    if (baseDuration > 0) {
      regressionPct = ((headDuration - baseDuration) / baseDuration) * 100;
    }
    return {
      query: r.query,
      baseDuration,
      headDuration,
      regressionPct: Math.round(regressionPct * 100) / 100,
      isRegression: regressionPct > REGRESSION_THRESHOLD_PCT,
    };
  });
}
