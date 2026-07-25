import "dotenv/config";
import { query, pool } from "../db/index.js";
import { logger } from "../logger.js";
import fs from "fs/promises";
import path from "path";

interface Vault {
  id: string;
  name: string;
  symbol: string;
  [key: string]: unknown;
}

interface Position {
  vault_id: string;
  user_address: string;
  share_balance: string;
  deposit_total: string;
  [key: string]: unknown;
}

interface Epoch {
  id: string;
  vault_id: string;
  epoch_number: number;
  [key: string]: unknown;
}

async function exportData(): Promise<void> {
  try {
    logger.info("Starting data export");

    // Create timestamped directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5); // YYYY-MM-DDTHH-mm-ss
    const exportDir = path.join(process.cwd(), "exports", timestamp);

    await fs.mkdir(exportDir, { recursive: true });
    logger.info({ exportDir }, "Created export directory");

    // Export vaults
    const vaults = await query<Vault>("SELECT * FROM vaults ORDER BY id ASC");
    const vaultsPath = path.join(exportDir, "vaults.json");
    await fs.writeFile(vaultsPath, JSON.stringify(vaults, null, 2));
    logger.info({ count: vaults.length, path: vaultsPath }, "Exported vaults");

    // Validate vaults.json
    try {
      JSON.parse(JSON.stringify(vaults));
    } catch (err) {
      throw new Error(`Invalid vaults.json: ${err}`);
    }

    // Export positions
    const positions = await query<Position>(
      "SELECT * FROM user_vault_positions ORDER BY vault_id ASC, user_address ASC"
    );
    const positionsPath = path.join(exportDir, "positions.json");
    await fs.writeFile(positionsPath, JSON.stringify(positions, null, 2));
    logger.info({ count: positions.length, path: positionsPath }, "Exported positions");

    // Validate positions.json
    try {
      JSON.parse(JSON.stringify(positions));
    } catch (err) {
      throw new Error(`Invalid positions.json: ${err}`);
    }

    // Export epochs
    const epochs = await query<Epoch>(
      "SELECT * FROM epochs ORDER BY vault_id ASC, epoch_number ASC"
    );
    const epochsPath = path.join(exportDir, "epochs.json");
    await fs.writeFile(epochsPath, JSON.stringify(epochs, null, 2));
    logger.info({ count: epochs.length, path: epochsPath }, "Exported epochs");

    // Validate epochs.json
    try {
      JSON.parse(JSON.stringify(epochs));
    } catch (err) {
      throw new Error(`Invalid epochs.json: ${err}`);
    }

    logger.info(
      { exportDir, vaultCount: vaults.length, positionCount: positions.length, epochCount: epochs.length },
      "Data export completed successfully"
    );

    await pool.end();
  } catch (err) {
    logger.error(err, "Failed to export data");
    process.exit(1);
  }
}

await exportData();
process.exit(0);
