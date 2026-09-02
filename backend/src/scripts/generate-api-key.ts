import "dotenv/config";
import { randomBytes, createHash } from "crypto";
import { query } from "../db/index.js";

const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

function parseArgs(argv: string[]) {
  let role = "admin";
  let expiresInDays: number | null = null;
  let allowedMethods: string[] | null = null;
  let allowedCidrs: string[] | null = null;

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
    } else if (arg === "--allowed-methods") {
      // Comma-separated HTTP methods the key may use; omit the flag to allow all.
      const value = argv[++i];
      if (!value) {
        throw new Error("--allowed-methods requires a comma-separated list of HTTP methods");
      }
      allowedMethods = value
        .split(",")
        .map((method) => method.trim().toUpperCase())
        .filter(Boolean);
      const invalid = allowedMethods.filter((method) => !HTTP_METHODS.includes(method));
      if (invalid.length > 0) {
        throw new Error(`Invalid --allowed-methods value(s): ${invalid.join(", ")}`);
      }
      if (allowedMethods.length === 0) {
        throw new Error("--allowed-methods requires at least one HTTP method");
      }
    } else if (arg === "--allowed-cidrs") {
      // Comma-separated CIDR ranges the key may be used from; omit to allow all.
      const value = argv[++i];
      if (!value) {
        throw new Error("--allowed-cidrs requires a comma-separated list of CIDR ranges");
      }
      allowedCidrs = value
        .split(",")
        .map((cidr) => cidr.trim())
        .filter(Boolean);
      if (allowedCidrs.length === 0) {
        throw new Error("--allowed-cidrs requires at least one CIDR range");
      }
    }
  }

  return { role, expiresInDays, allowedMethods, allowedCidrs };
}

const { role, expiresInDays, allowedMethods, allowedCidrs } = parseArgs(process.argv.slice(2));

const plaintext = randomBytes(32).toString("hex");
const keyHash = createHash("sha256").update(plaintext).digest("hex");
const expiresAt = expiresInDays !== null
  ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
  : null;

await query(
  `INSERT INTO api_keys (key_hash, role, label, expires_at, allowed_methods, allowed_cidrs)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [keyHash, role, `generated-${Date.now()}`, expiresAt, allowedMethods, allowedCidrs],
);

console.log(plaintext);
process.exit(0);
