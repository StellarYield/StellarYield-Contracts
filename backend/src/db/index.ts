import pg from "pg";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { trace, SpanStatusCode, context } from "@opentelemetry/api";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getCurrentRoute, getCurrentMethod } from "../api/middleware/requestContext.js";
import { AppError, ErrorCode } from "../api/middleware/errors.js";

const tracer = trace.getTracer("stellaryield-db");

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  min: config.db.poolMin,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  query_timeout: config.db.queryTimeoutMs,
});

// Set lock_timeout and statement_timeout on every new connection so that
// runaway queries and lock-wait storms never silently stall the API. (#1227)
pool.on("connect", (client) => {
  const lockTimeoutMs = config.db.queryTimeoutMs ?? 30_000;
  const stmtTimeoutMs = config.db.queryTimeoutMs ?? 30_000;
  client.query(
    `SET lock_timeout = '${lockTimeoutMs}ms'; SET statement_timeout = '${stmtTimeoutMs}ms';`,
  ).catch((err: unknown) => {
    logger.warn({ err }, "Failed to set DB session timeouts on new connection");
  });
});

// ── Reconnect state (#1255) ───────────────────────────────────────────────────
// When the database connection is lost (restart, network partition), the pool
// emits 'error'. We retry `SELECT 1` with exponential backoff (max 30 s) until
// the connection is restored. `dbStatus` is read by /health to report
// "reconnecting" so operators can see the transient state.
let dbStatus: "connected" | "reconnecting" = "connected";

export function getDbStatus(): "connected" | "reconnecting" {
  return dbStatus;
}

const MAX_BACKOFF_MS = 30_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReconnect(): void {
  if (reconnectTimer) return; // already scheduled
  let attempt = 0;
  const tryReconnect = async (): Promise<void> => {
    attempt += 1;
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      dbStatus = "connected";
      reconnectTimer = undefined;
      logger.info({ attempts: attempt }, "Database reconnected");
    } catch {
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      logger.warn({ attempt, backoffMs: backoff }, "Database reconnect failed; retrying");
      reconnectTimer = setTimeout(tryReconnect, backoff);
    }
  };
  dbStatus = "reconnecting";
  reconnectTimer = setTimeout(tryReconnect, 1000);
}

// Emit a reconnect attempt whenever the pool loses a connection unexpectedly.
pool.on("error", (err: Error) => {
  logger.error({ err }, "Database pool error");
  if (dbStatus !== "reconnecting") {
    scheduleReconnect();
  }
});

// Read-replica pool (#949). When DATABASE_READ_URL is set, read-only queries
// issued from GET request handlers are routed here to keep write-heavy admin
// and analytics traffic off the primary's connection pool. When it is unset,
// `readPool` is the primary pool, so all queries hit the primary.
export const readPool: pg.Pool = config.db.readUrl
  ? new Pool({
      connectionString: config.db.readUrl,
      min: config.db.poolMin,
      max: config.db.poolMax,
      idleTimeoutMillis: config.db.idleTimeoutMs,
      query_timeout: config.db.queryTimeoutMs,
    })
  : pool;

if (config.db.readUrl && readPool !== pool) {
  readPool.on("error", (err: Error) => {
    logger.error({ err }, "Read replica pool error");
  });
}

function setupPoolMetrics(p: pg.Pool, isRead: boolean): void {
  import("../services/metrics.js")
    .then(({ updatePgPoolMetrics }) => {
      const update = () => updatePgPoolMetrics(p, isRead);
      p.on("connect", update);
      p.on("acquire", update);
      p.on("release", update);
      p.on("remove", update);
      update();
    })
    .catch(() => {
      // Ignore in environments without metrics
    });
}

setupPoolMetrics(pool, false);
if (config.db.readUrl && readPool !== pool) {
  setupPoolMetrics(readPool, true);
}

const READ_ONLY_STATEMENT = /^\s*(?:select|show|explain)\b/i;

/**
 * Pick the pool for the current query: the read replica for read-only
 * statements issued inside a GET request handler, the primary for everything
 * else — writes (even those fired from a GET handler, such as the api_keys
 * last-used stamp), background jobs, the indexer, and scripts. Falls back to
 * the primary whenever no read replica is configured (`readPool === pool`).
 */
function poolForCurrentQuery(sql: string): pg.Pool {
  if (readPool === pool) return pool;
  if (getCurrentMethod() !== "GET") return pool;
  return READ_ONLY_STATEMENT.test(sql) ? readPool : pool;
}

export function redactQueryParameters(sql: string): string {
  return sql
    .replace(/'[^']*'/g, "'[REDACTED]'")
    .replace(/"[^"]*"/g, '"[REDACTED]"')
    .trim();
}

async function logSlowQuery(sql: string, durationMs: number): Promise<void> {
  try {
    const queryHash = crypto.createHash("sha256").update(sql).digest("hex");
    const queryPreview = redactQueryParameters(sql).slice(0, 200);
    const route = getCurrentRoute();
    await pool.query(
      `INSERT INTO slow_query_log (query_hash, query_preview, duration_ms, route)
       VALUES ($1, $2, $3, $4)`,
      [queryHash, queryPreview, durationMs, route],
    );
  } catch (err) {
    logger.error({ err }, "Failed to log slow query");
  }
}

// Prepared statement registry for hot queries
const preparedStatements = new Map<string, { name: string; text: string }>();

export function registerPreparedStatement(name: string, text: string): void {
  preparedStatements.set(name, { name, text });
  logger.debug({ name }, "Registered prepared statement");
}

// ── Transactions (#1210) ─────────────────────────────────────────────────────
// `withTransaction` pins one connection for everything that runs inside it. The
// client is carried through AsyncLocalStorage, so `query` calls made by nested
// services join the transaction without their signatures changing.
const transactionStore = new AsyncLocalStorage<pg.PoolClient>();

/**
 * Run `fn` inside a single database transaction. Commits when `fn` resolves and
 * rolls back, then rethrows, when it rejects. Queries issued from within `fn`
 * (including through nested service calls) run on the same connection.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactionStore.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, "Failed to roll back transaction");
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  options?: { timeoutMs?: number },
): Promise<T[]> {
  const span = tracer.startSpan("db.query", {}, context.active());
  span.setAttribute("db.statement", sql.slice(0, 80));

  const start = performance.now();
  const transactionClient = transactionStore.getStore();
  const activePool = poolForCurrentQuery(sql);
  try {
    let result: pg.QueryResult;
    const timeoutMs = options?.timeoutMs;
    if (transactionClient) {
      result = await transactionClient.query(sql, params);
    } else if (timeoutMs) {
      const client = await activePool.connect();
      try {
        await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
        result = await client.query(sql, params);
      } catch (err: any) {
        if (err?.code === "57014") {
          throw new AppError(ErrorCode.QUERY_TIMEOUT, "Query timed out", 504);
        }
        throw err;
      } finally {
        client.release();
      }
    } else {
      result = await activePool.query(sql, params);
    }

    const durationMs = performance.now() - start;
    const roundedMs = Math.round(durationMs * 100) / 100;

    span.setAttribute("db.response.rows", result.rowCount ?? 0);

    if (durationMs > config.db.slowQueryMs) {
      logger.warn(
        { sql, paramsCount: params?.length ?? 0, durationMs: roundedMs, rowCount: result.rowCount },
        "slow query",
      );
      if (!sql.includes("slow_query_log")) {
        logSlowQuery(sql, roundedMs).catch(() => {});
      }
    } else if (logger.level === "debug" || logger.level === "trace") {
      const firstLine = config.nodeEnv === "production" ? sql.slice(0, 80) : sql;
      logger.debug({ sql: firstLine, durationMs: roundedMs, rowCount: result.rowCount }, "query");
    }

    return result.rows as T[];
  } catch (err) {
    if (err instanceof AppError) throw err;
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

export async function queryPrepared<T = Record<string, unknown>>(
  name: string,
  params?: unknown[],
  options?: { timeoutMs?: number },
): Promise<T[]> {
  const stmt = preparedStatements.get(name);
  if (!stmt) {
    throw new Error(`Prepared statement "${name}" not registered`);
  }
  const transactionClient = transactionStore.getStore();
  if (transactionClient) {
    const result = await transactionClient.query({ name: stmt.name, text: stmt.text, values: params });
    return result.rows;
  }
  const activePool = poolForCurrentQuery(stmt.text);
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs) {
    const client = await activePool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const result = await client.query({ name: stmt.name, text: stmt.text, values: params });
      return result.rows;
    } catch (err: any) {
      if (err?.code === "57014") {
        throw new AppError(ErrorCode.QUERY_TIMEOUT, "Query timed out", 504);
      }
      throw err;
    } finally {
      client.release();
    }
  }
  const result = await activePool.query({ name: stmt.name, text: stmt.text, values: params });
  return result.rows;
}

async function prepareStatements(): Promise<void> {
  for (const [key, stmt] of preparedStatements) {
    try {
      await pool.query(`PREPARE ${stmt.name} AS ${stmt.text}`);
      logger.debug({ name: key }, "Prepared statement cached");
    } catch {
      // Statement may already be prepared — ignore
    }
  }
  logger.info({ count: preparedStatements.size }, "Prepared statements initialized");
}

async function validateConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info("Database connection established");
  } finally {
    client.release();
  }
}

/**
 * Pre-warm the primary pool by opening POOL_WARMUP_CONNECTIONS connections
 * upfront and returning them to the pool idle, so the first burst of traffic
 * after startup never blocks on TCP + TLS + auth handshakes (#951). Called
 * before the HTTP server starts accepting requests. A failure here is logged
 * but never fatal — the pool will establish connections lazily instead.
 */
export async function warmUpPool(): Promise<void> {
  const target = config.db.poolWarmupConnections;
  if (target <= 0) return;
  try {
    const clients = await Promise.all(
      Array.from({ length: target }, () => pool.connect()),
    );
    for (const client of clients) client.release();
    logger.info(`Database pool warmed up with ${target} connections`);
  } catch (err) {
    logger.error({ err }, "Database pool warm-up failed; continuing startup");
  }
}

/**
 * End the primary pool (and the read replica, when configured) exactly once.
 *
 * Idempotent: shutdown may be triggered by both SIGTERM and SIGINT, and the
 * ordered shutdown orchestrator (#1294) calls this as its final step so the pool
 * is only closed after the indexer and job queue have drained.
 */
let poolClosed = false;
export async function closePool(): Promise<void> {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
  if (readPool !== pool) await readPool.end();
}

// ── Pool exhaustion alerting (#828) ───────────────────────────────────────────
// Every 10 s, log at error level if the number of queued connection requests
// exceeds DB_POOL_ALERT_WAITING (default 5). Healthy operation never logs here.
if (process.env["NODE_ENV"] !== "test") {
  setInterval(() => {
    const waiting = pool.waitingCount;
    if (waiting > config.dbPoolAlertWaiting) {
      logger.error(`DB pool exhaustion: ${waiting} connections waiting`);
    }
  }, 10_000).unref();
}

// Validate on startup — exit immediately if DATABASE_URL is unreachable
if (process.env["NODE_ENV"] !== "test") {
  validateConnection()
    .then(() => prepareStatements())
    .catch((err) => {
      logger.error(err, "Failed to connect to database");
      process.exit(1);
    });
}
