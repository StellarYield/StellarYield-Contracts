import "dotenv/config";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),
  nodeEnv: optional("NODE_ENV", "development"),

  stellar: {
    network: optional("STELLAR_NETWORK", "testnet"),
    rpcUrl: optional(
      "STELLAR_RPC_URL",
      "https://soroban-testnet.stellar.org",
    ),
    networkPassphrase: optional(
      "STELLAR_NETWORK_PASSPHRASE",
      "Test SDF Network ; September 2015",
    ),
    vaultFactoryContractId: optional("VAULT_FACTORY_CONTRACT_ID", ""),
  },

  db: {
    url: required("DATABASE_URL"),
  },

  indexer: {
    startLedger: parseInt(optional("INDEXER_START_LEDGER", "0"), 10),
    pollIntervalMs: parseInt(optional("INDEXER_POLL_INTERVAL_MS", "5000"), 10),
  },

  allowedOrigins: (() => {
    const raw = process.env.ALLOWED_ORIGINS;
    if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (optional("NODE_ENV", "development") === "development") return ["*"];
    return [];
  })(),

  webhookSecret: optional("WEBHOOK_SECRET", ""),
} as const;
