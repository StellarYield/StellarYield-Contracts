import "dotenv/config";
import { z } from "zod";
import cron from "node-cron";

export const envSchema = z.object({
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
  // Optional read replica. SELECT-only (GET handler) queries are routed here to
  // offload the primary. Falls back to DATABASE_URL when unset (#949).
  DATABASE_READ_URL: z
    .string()
    .optional()
    .refine((v) => v === undefined || /^postgres(ql)?:\/\/.+/.test(v), {
      message: "DATABASE_READ_URL must be a valid PostgreSQL connection string (postgresql://...)",
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
  RATE_LIMIT_SIMULATE: z
    .string()
    .default("30")
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
  // Connections to establish upfront once the pool is validated, so cold-start
  // requests never wait on connection setup under load (#951).
  POOL_WARMUP_CONNECTIONS: z
    .string()
    .default("3")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(0)),
  SLOW_QUERY_THRESHOLD_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(1).optional()),
  MAX_RESPONSE_SIZE_MB: z
    .string()
    .default("50")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  EVENTS_RETENTION_DAYS: z
    .string()
    .default("90")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  ARCHIVE_CRON: z
    .string()
    .default("0 2 * * *")
    .refine((v) => cron.validate(v), {
      message: "ARCHIVE_CRON must be a valid cron expression",
    }),
  DRY_RUN: z
    .string()
    .default("false")
    .transform((v) => ["true", "1", "yes"].includes(v.toLowerCase())),
  ADMIN_IP_ALLOWLIST: z
    .string()
    .default(""),
  REQUEST_BODY_LIMIT: z
    .string()
    .default("100kb"),
  INTERNAL_SECRET: z
    .string()
    .default(""),
  ADMIN_JWT_SECRET: z
    .string()
    .default("change-me-in-production"),
  ADMIN_SESSION_EXPIRY_MINUTES: z
    .string()
    .default("60")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1)),
  SANDBOX_MODE: z
    .string()
    .default("false")
    .transform((v) => ["true", "1", "yes"].includes(v.toLowerCase())),
  ENABLE_SANDBOX_RESET: z
    .string()
    .default("false")
    .transform((v) => ["true", "1", "yes"].includes(v.toLowerCase())),
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
  KEY_INACTIVITY_DAYS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : null))
    .pipe(z.number().int().min(1).nullable().default(null)),
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
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : null))
    .pipe(z.number().int().min(1).max(65535).nullable()),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  DEPLOY_ID: z.string().optional(),
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

  get adminJwtSecret() {
    return process.env.ADMIN_JWT_SECRET ?? parsed.data.ADMIN_JWT_SECRET;
  },
  get adminSessionExpiryMinutes() {
    return Number(process.env.ADMIN_SESSION_EXPIRY_MINUTES ?? parsed.data.ADMIN_SESSION_EXPIRY_MINUTES);
  },
  get sandboxMode() {
    return (process.env.SANDBOX_MODE ?? String(parsed.data.SANDBOX_MODE)).toLowerCase() === "true" || process.env.SANDBOX_MODE === "1";
  },
  get enableSandboxReset() {
    return (process.env.ENABLE_SANDBOX_RESET ?? String(parsed.data.ENABLE_SANDBOX_RESET)).toLowerCase() === "true" || process.env.ENABLE_SANDBOX_RESET === "1";
  },
  get archiveCron(): string {
    return process.env.ARCHIVE_CRON ?? parsed.data.ARCHIVE_CRON;
  },
  get dryRun(): boolean {
    return ["true", "1", "yes"].includes((process.env.DRY_RUN ?? String(parsed.data.DRY_RUN)).toLowerCase());
  },

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
    readUrl: parsed.data.DATABASE_READ_URL ?? null,
    poolMin: parsed.data.DB_POOL_MIN,
    poolMax: parsed.data.DB_POOL_MAX,
    idleTimeoutMs: parsed.data.DB_IDLE_TIMEOUT_MS,
    queryTimeoutMs: parsed.data.DB_QUERY_TIMEOUT_MS,
    slowQueryMs: parsed.data.SLOW_QUERY_THRESHOLD_MS ?? parsed.data.DB_SLOW_QUERY_MS,
    poolWarmupConnections: parsed.data.POOL_WARMUP_CONNECTIONS,
  },
  maxResponseSizeMb: parsed.data.MAX_RESPONSE_SIZE_MB,

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
    simulate: parsed.data.RATE_LIMIT_SIMULATE,
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
  // Days of inactivity after which an API key is deactivated; null disables
  // the sweep entirely (#934).
  apiKeyInactivityDays: parsed.data.KEY_INACTIVITY_DAYS,
  otelEndpoint: parsed.data.OTEL_EXPORTER_OTLP_ENDPOINT,
  sseReplayBufferSize: parsed.data.SSE_REPLAY_BUFFER,
  dbPoolAlertWaiting: parsed.data.DB_POOL_ALERT_WAITING,
  rpcErrorRateAlertPct: parsed.data.RPC_ERROR_RATE_ALERT_PCT,

  smtp: {
    host: parsed.data.SMTP_HOST,
    port: parsed.data.SMTP_PORT,
    user: parsed.data.SMTP_USER,
    pass: parsed.data.SMTP_PASS,
    from: parsed.data.SMTP_FROM,
  },
  deployId: parsed.data.DEPLOY_ID ?? null,
} as const;

export const ROUTE_CACHE_CONTROL: Record<string, number> = {
  "/api/v1/vaults": 60,
  "/api/v1/yields": 60,
  "/api/v1/analytics": 300,
  "/health": 0,
};

