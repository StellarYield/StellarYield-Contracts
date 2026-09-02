import { pool } from "./index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function seed() {
  console.log("Seeding database...");

  // Insert sample vaults
  await pool.query(`
    INSERT INTO vaults (contract_id, factory_id, asset, name, symbol, state, total_assets, total_supply)
    VALUES 
      ('CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B', 'FACTORY123', 'XLM', 'Stellar Lumens Vault', 'SVXLM', 'Funding', 1000000, 500000),
      ('GALAXYVAULTCONTRACTID123456789', 'FACTORY123', 'USDC', 'USD Coin Vault', 'SVUSDC', 'Active', 2500000, 1200000)
    ON CONFLICT (contract_id) DO NOTHING
  `);
  console.log("Inserted 2 sample vaults");

  // Insert sample user
  await pool.query(`
    INSERT INTO users (address, kyc_verified)
    VALUES ('GDUKQHGK4JLJXZM7KQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ5JQ', true)
    ON CONFLICT (address) DO NOTHING
  `);
  console.log("Inserted 1 sample user");

  console.log("Seeding complete.");
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
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}
