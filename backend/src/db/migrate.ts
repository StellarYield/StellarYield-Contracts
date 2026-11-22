import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pool } from "./index.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "migrations");

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS migrations (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    applied_at  TIMESTAMPTZ DEFAULT NOW()
  );
`;

/**
 * Apply every not-yet-applied migration in `MIGRATIONS_DIR`, in filename
 * order, each inside its own transaction. Idempotent: already applied
 * migrations are skipped.
 */
export async function applyMigrations(dbPool: pg.Pool): Promise<void> {
  await dbPool.query(CREATE_MIGRATIONS_TABLE);

  const { rows: applied } = await dbPool.query<{ name: string }>(
    "SELECT name FROM migrations ORDER BY id",
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      logger.info({ file }, "Skipping migration (already applied)");
      continue;
    }

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    const client = await dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info({ file }, "Applied migration");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info("Migration complete.");
}

/**
 * Revert every migration on the database. The migration files ship up-only
 * SQL, so a full "down" pass drops every view, table and enum type the
 * migrations created (and the `migrations` table itself). Intended for
 * schemes/tests that rebuild a schema from scratch — never pointed at data
 * you intend to keep.
 */
export async function revertMigrations(dbPool: pg.Pool): Promise<void> {
  await dbPool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      -- Tables first: CASCADE removes their dependent views too.
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
      END LOOP;
      -- Any remaining views (two rounds for view-on-view dependencies).
      FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
      END LOOP;
      FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
      END LOOP;
      FOR r IN (
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'
      ) LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I', r.typname);
      END LOOP;
    END
    $$;
  `);
  logger.info("Migration revert complete.");
}

const isDirectScriptRun = (() => {
  const scriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
  return scriptPath !== null && scriptPath === fileURLToPath(import.meta.url);
})();

if (isDirectScriptRun) {
  applyMigrations(pool)
    .then(async () => {
      await pool.end();
    })
    .catch((err) => {
      logger.error({ err }, "Migration failed");
      // Flush the async logger transport before exiting so the failure is not lost.
      logger.flush(() => process.exit(1));
    });
}
