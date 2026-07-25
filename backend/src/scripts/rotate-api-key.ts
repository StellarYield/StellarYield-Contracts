import "dotenv/config";
import { randomBytes, createHash } from "crypto";
import { query, pool } from "../db/index.js";
import { logger } from "../logger.js";
import readline from "readline";

interface ApiKey {
  id: number;
  key_hash: string;
  role: string;
  label: string;
  expires_at: string | null;
  created_at: string;
}

function parseArgs(argv: string[]): { label?: string } {
  let label: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label") {
      label = argv[++i];
    }
  }

  return { label };
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase());
    });
  });
}

async function rotateApiKey(label: string): Promise<void> {
  try {
    logger.info({ label }, "Starting API key rotation");

    // Find existing key
    const keys = await query<ApiKey>(
      "SELECT * FROM api_keys WHERE label = $1",
      [label]
    );

    if (keys.length === 0) {
      logger.error({ label }, "API key not found");
      await pool.end();
      process.exit(1);
    }

    const oldKey = keys[0];
    const role = oldKey.role;

    logger.info({ label, role, keyId: oldKey.id }, "Found existing API key");

    // Generate new key
    const plaintext = randomBytes(32).toString("hex");
    const keyHash = createHash("sha256").update(plaintext).digest("hex");
    const newLabel = `${label}-rotated-${Date.now()}`;
    const expiresAt = oldKey.expires_at;

    // Insert new key
    await query(
      "INSERT INTO api_keys (key_hash, role, label, expires_at) VALUES ($1, $2, $3, $4)",
      [keyHash, role, newLabel, expiresAt]
    );

    logger.info({ label: newLabel }, "New API key generated");
    console.log(`\nNew API Key (save this - it won't be shown again):`);
    console.log(plaintext);
    console.log(`\nLabel: ${newLabel}`);
    console.log(`Role: ${role}\n`);

    // Prompt for deletion
    const answer = await prompt("Delete old key? [y/N] ");

    if (answer === "y" || answer === "yes") {
      await query("DELETE FROM api_keys WHERE id = $1", [oldKey.id]);
      logger.info({ oldKeyId: oldKey.id }, "Old API key deleted");
      console.log("Old key deleted successfully.\n");
    } else {
      logger.info({ oldKeyId: oldKey.id }, "Old key was not deleted");
      console.log("Old key was not deleted. Please delete it manually if needed.\n");
    }

    logger.info({ label }, "API key rotation completed");
    await pool.end();
  } catch (err) {
    logger.error(err, "Failed to rotate API key");
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));

if (!args.label) {
  console.error("Usage: rotate-api-key --label <label>");
  console.error("Example: rotate-api-key --label my-admin-key");
  process.exit(1);
}

await rotateApiKey(args.label);
process.exit(0);
