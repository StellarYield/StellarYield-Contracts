// Reverting migrations from the CLI: `npm run db:migrate:down`. Drops every
// view, table and enum type the migrations created (see revertMigrations).
// Never point this at a database you intend to keep data in.
import { revertMigrations } from "./migrate.js";
import { pool } from "./index.js";
import { logger } from "../logger.js";

revertMigrations(pool)
  .then(async () => {
    await pool.end();
  })
  .catch((err) => {
    logger.error({ err }, "Migration revert failed");
    // Flush the async logger transport before exiting so the failure is not lost.
    logger.flush(() => process.exit(1));
  });
