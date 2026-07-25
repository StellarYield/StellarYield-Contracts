import "dotenv/config";
import { randomBytes, createHash } from "crypto";
import { query } from "../db/index.js";

function parseArgs(argv: string[]) {
  let role = "admin";
  let expiresInDays: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--role") {
      const value = argv[++i];
      if (value !== "admin" && value !== "readonly") {
        throw new Error(`Invalid --role value: ${value} (expected "admin" or "readonly")`);
      }
      role = value;
    } else if (arg === "--expires-in") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--expires-in must be a positive number of days");
      }
      expiresInDays = value;
    }
  }

  return { role, expiresInDays };
}

const { role, expiresInDays } = parseArgs(process.argv.slice(2));

const plaintext = randomBytes(32).toString("hex");
const keyHash = createHash("sha256").update(plaintext).digest("hex");
const expiresAt = expiresInDays !== null
  ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
  : null;

await query(
  "INSERT INTO api_keys (key_hash, role, label, expires_at) VALUES ($1, $2, $3, $4)",
  [keyHash, role, `generated-${Date.now()}`, expiresAt],
);

console.log(plaintext);
process.exit(0);
