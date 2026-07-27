import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z
    .string()
    .default("development"),
  STELLAR_NETWORK: z
    .enum(["testnet", "mainnet", "futurenet"])
    .default("testnet"),
  STELLAR_RPC_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://"), {
      message: "STELLAR_RPC_URL must use HTTPS",
    }),
  STELLAR_RPC_FALLBACKS: z
    .string()
    .default(""),
  STELLAR_RPC_TIMEOUT_MS: z
    .string()
    .default("10000")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1000)),
  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .optional(),
  VAULT_FACTORY_CONTRACT_ID: z
    .string()
    .default(""),
  DATABASE_URL: z
    .string()
    .refine((v) => /^postgres(ql)?:\/\/.+/.test(v), {
      message: "DATABASE_URL must be a valid PostgreSQL connection string (postgresql://...)",
    }),
  INDEXER_START_LEDGER: z
    .string()
    .default("0")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  INDEXER_POLL_INTERVAL_MS: z
    .string()
    .default("5000")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(100)),
  INDEXER_BATCH_SIZE: z
    .string()
    .default("200")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  INDEXER_LAG_ALERT_LEDGERS: z
    .string()
    .default("100")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  WEBHOOK_SECRET: z
    .string()
    .default(""),
  LOG_LEVEL: z
    .string()
    .default("info"),
  ALLOWED_ORIGINS: z
    .string()
    .default(""),
  RATE_LIMIT_PUBLIC: z
    .string()
    .default("60")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  RATE_LIMIT_AUTH: z
    .string()
    .default("300")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  DB_POOL_MIN: z
    .string()
    .default("2")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  DB_POOL_MAX: z
    .string()
    .default("10")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  DB_IDLE_TIMEOUT_MS: z
    .string()
    .default("10000")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  DB_QUERY_TIMEOUT_MS: z
    .string()
    .default("30000")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  DB_SLOW_QUERY_MS: z
    .string()
    .default("500")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  EVENTS_RETENTION_DAYS: z
    .string()
    .default("90")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  ADMIN_IP_ALLOWLIST: z
    .string()
    .default(""),
  REQUEST_BODY_LIMIT: z
    .string()
    .default("100kb"),
  INTERNAL_SECRET: z
    .string()
    .default(""),
  CORS_MAX_AGE: z
    .string()
    .default("600")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  SSE_HEARTBEAT_MS: z
    .string()
    .default("15000")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  YIELD_CLAIM_EXPIRY_DAYS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : null))
    .pipe(z.number().int().min(1).nullable().default(null)),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SSE_REPLAY_BUFFER: z
    .string()
    .default("100")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  DB_POOL_ALERT_WAITING: z
    .string()
    .default("5")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  RPC_ERROR_RATE_ALERT_PCT: z
    .string()
    .default("10")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1).max(100)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".");
    console.error(`  - ${path}: ${issue.message}`);
  }
  process.exit(1);
}

// Must be declared before `config` so `getDefaultPassphrase` can use them.
const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

function getDefaultPassphrase(network: string): string {
  return NETWORK_PASSPHRASES[network] ?? NETWORK_PASSPHRASES.testnet;
}

export const config = {
  port: parsed.data.PORT,
  nodeEnv: parsed.data.NODE_ENV,

  stellar: {
    network: parsed.data.STELLAR_NETWORK,
    rpcUrl: parsed.data.STELLAR_RPC_URL,
    rpcFallbacks: parsed.data.STELLAR_RPC_FALLBACKS
      ? parsed.data.STELLAR_RPC_FALLBACKS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    rpcTimeoutMs: parsed.data.STELLAR_RPC_TIMEOUT_MS,
    networkPassphrase: parsed.data.STELLAR_NETWORK_PASSPHRASE
      ?? getDefaultPassphrase(parsed.data.STELLAR_NETWORK),
    vaultFactoryContractId: parsed.data.VAULT_FACTORY_CONTRACT_ID,
  },

  db: {
    url: parsed.data.DATABASE_URL,
    poolMin: parsed.data.DB_POOL_MIN,
    poolMax: parsed.data.DB_POOL_MAX,
    idleTimeoutMs: parsed.data.DB_IDLE_TIMEOUT_MS,
    queryTimeoutMs: parsed.data.DB_QUERY_TIMEOUT_MS,
    slowQueryMs: parsed.data.DB_SLOW_QUERY_MS,
  },

  indexer: {
    startLedger: parsed.data.INDEXER_START_LEDGER,
    pollIntervalMs: parsed.data.INDEXER_POLL_INTERVAL_MS,
    batchSize: parsed.data.INDEXER_BATCH_SIZE,
    lagAlertLedgers: parsed.data.INDEXER_LAG_ALERT_LEDGERS,
  },

  allowedOrigins: (() => {
    const raw = parsed.data.ALLOWED_ORIGINS;
    if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parsed.data.NODE_ENV === "development") return ["*"];
    return [];
  })(),

  webhookSecret: parsed.data.WEBHOOK_SECRET,
  logLevel: parsed.data.LOG_LEVEL,

  rateLimit: {
    public: parsed.data.RATE_LIMIT_PUBLIC,
    auth: parsed.data.RATE_LIMIT_AUTH,
  },

  eventsRetentionDays: parsed.data.EVENTS_RETENTION_DAYS,

  adminIpAllowlist: parsed.data.ADMIN_IP_ALLOWLIST
    ? parsed.data.ADMIN_IP_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
    : [],

  requestBodyLimit: parsed.data.REQUEST_BODY_LIMIT,
  internalSecret: parsed.data.INTERNAL_SECRET,

  cors: {
    maxAge: parsed.data.CORS_MAX_AGE,
  },
  sseHeartbeatMs: parsed.data.SSE_HEARTBEAT_MS,
  yieldClaimExpiryDays: parsed.data.YIELD_CLAIM_EXPIRY_DAYS,
  otelEndpoint: parsed.data.OTEL_EXPORTER_OTLP_ENDPOINT,
  sseReplayBufferSize: parsed.data.SSE_REPLAY_BUFFER,
  dbPoolAlertWaiting: parsed.data.DB_POOL_ALERT_WAITING,
  rpcErrorRateAlertPct: parsed.data.RPC_ERROR_RATE_ALERT_PCT,
} as const;
