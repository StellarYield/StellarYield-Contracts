import pg, { type QueryResultRow } from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
});

pool.on("error", (err) => {
  logger.error(err, "Unexpected database pool error");
});

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
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

// Validate on startup — exit immediately if DATABASE_URL is unreachable
validateConnection().catch((err) => {
  logger.error(err, "Failed to connect to database");
  process.exit(1);
});
