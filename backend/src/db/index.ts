import pg from "pg";
import { performance } from "node:perf_hooks";
import { trace, SpanStatusCode, context } from "@opentelemetry/api";
import { config } from "../config.js";
import { logger } from "../logger.js";

const tracer = trace.getTracer("stellaryield-db");

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  min: config.db.poolMin,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  query_timeout: config.db.queryTimeoutMs,
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const span = tracer.startSpan("db.query", {}, context.active());
  span.setAttribute("db.statement", sql.slice(0, 80));

  const start = performance.now();
  try {
    const result = await pool.query(sql, params);
    const durationMs = performance.now() - start;
    const roundedMs = Math.round(durationMs * 100) / 100;

    span.setAttribute("db.response.rows", result.rowCount ?? 0);

    if (durationMs > config.db.slowQueryMs) {
      logger.warn(
        { sql, paramsCount: params?.length ?? 0, durationMs: roundedMs, rowCount: result.rowCount },
        "slow query",
      );
    } else if (logger.level === "debug" || logger.level === "trace") {
      const firstLine = config.nodeEnv === "production" ? sql.slice(0, 80) : sql;
      logger.debug({ sql: firstLine, durationMs: roundedMs, rowCount: result.rowCount }, "query");
    }

    return result.rows;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
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

process.on("SIGTERM", async () => {
  logger.info("Shutting down database pool");
  await pool.end();
});

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
  validateConnection().catch((err) => {
    logger.error(err, "Failed to connect to database");
    process.exit(1);
  });
}
