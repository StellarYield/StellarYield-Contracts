import { pool } from "./index.js";
import { logger } from "../logger.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function seed() {
  logger.info("Seeding database...");

  // Insert sample vaults
  await pool.query(`
    INSERT INTO vaults (contract_id, factory_id, asset, name, symbol, state, total_assets, total_supply)
    VALUES 
      ('CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B', 'FACTORY123', 'XLM', 'Stellar Lumens Vault', 'SVXLM', 'Funding', 1000000, 500000),
      ('GALAXYVAULTCONTRACTID123456789', 'FACTORY123', 'USDC', 'USD Coin Vault', 'SVUSDC', 'Active', 2500000, 1200000)
    ON CONFLICT (contract_id) DO NOTHING
  `);
  logger.info("Inserted 2 sample vaults");

  // Insert sample user
  await pool.query(`
    INSERT INTO users (address, kyc_verified)
    VALUES ('GDUKQHGK4JLJXZM7KQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ', true)
    ON CONFLICT (address) DO NOTHING
  `);
  logger.info("Inserted 1 sample user");

  logger.info("Seeding complete.");
}

const isDirectScriptRun = (() => {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  return scriptPath !== null && scriptPath === fileURLToPath(import.meta.url);
})();

if (isDirectScriptRun) {
  seed()
    .then(async () => {
      await pool.end();
    })
    .catch((err) => {
      logger.error({ err }, "Seeding failed");
      // Flush the async logger transport before exiting so the failure is not lost.
      logger.flush(() => process.exit(1));
    });
}
