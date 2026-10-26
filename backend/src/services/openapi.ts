import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type { Express } from "express";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const vaultStateSchema = z.enum(["Funding", "Active", "Matured", "Closed", "Cancelled"]);

const vaultSchema = z.object({
  id: z.number().openapi({ example: 1 }),
  contractId: z.string().openapi({ example: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" }),
  factoryId: z.string().nullable().openapi({ example: "CDVBDO2GW7445HWUITG6E437GZERAUYBG4X5HZRQC2ZEFMV3Y5HGDY52" }),
  asset: z.string().openapi({ example: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEADQSKZRXGQ6E4DFR" }),
  name: z.string().nullable().openapi({ example: "Treasury Bill Vault" }),
  symbol: z.string().nullable().openapi({ example: "sTBill" }),
  state: vaultStateSchema.openapi({ example: "Active" }),
  totalAssets: z.string().openapi({ example: "1000000000000" }),
  totalSupply: z.string().openapi({ example: "950000000000" }),
  depositorCount: z.number().openapi({ example: 42 }),
  fundingTarget: z.string().nullable().openapi({ example: "5000000000000" }),
  fundingDeadline: z.string().nullable().openapi({ example: "2026-12-31T00:00:00.000Z" }),
  fundingProgress: z.number().nullable().openapi({ example: 20.5 }),
  minDeposit: z.string().nullable().openapi({ example: "10000000" }),
  maxDepositPerUser: z.string().nullable().openapi({ example: "100000000000" }),
  rwaName: z.string().nullable().optional().openapi({ example: "US Treasury Bill" }),
  rwaSymbol: z.string().nullable().optional().openapi({ example: "USTB" }),
  rwaDocumentUri: z.string().nullable().optional().openapi({ example: "https://example.com/docs/tbill.pdf" }),
  rwaCategory: z.string().nullable().optional().openapi({ example: "Government Debt" }),
  description: z.string().nullable().optional().openapi({ example: "Tokenized short-term US Treasury bills" }),
  logoUri: z.string().nullable().optional().openapi({ example: "https://example.com/logo.png" }),
  createdAt: z.string().openapi({ example: "2026-01-15T00:00:00.000Z" }),
  updatedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
  // #1275 – 1 - totalSupply / supplyAtMaturity. Present only for Matured vaults.
  redeemedPct: z.number().optional().openapi({ example: 0.35 }),
});

const paginatedVaultsSchema = z.object({
  data: z.array(vaultSchema).openapi({ example: [] }),
  total: z.number().openapi({ example: 1 }),
  page: z.number().openapi({ example: 1 }),
  pageSize: z.number().openapi({ example: 20 }),
});

const vaultHolderSchema = z.object({
  userAddress: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
  shares: z.string().openapi({ example: "1000000000" }),
  deposited: z.string().openapi({ example: "1000000000" }),
  lastUpdatedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
});

const paginatedVaultHoldersSchema = z.object({
  data: z.array(vaultHolderSchema),
  total: z.number().openapi({ example: 10 }),
  page: z.number().openapi({ example: 1 }),
  pageSize: z.number().openapi({ example: 20 }),
});

const userSchema = z.object({
  id: z.number().openapi({ example: 1 }),
  address: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
  kycVerified: z.boolean().openapi({ example: true }),
  createdAt: z.string().openapi({ example: "2026-01-15T00:00:00.000Z" }),
  updatedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
});

const userPortfolioSchema = z.object({
  positions: z.array(z.object({
    id: z.number().openapi({ example: 1 }),
    userAddress: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
    vaultId: z.number().openapi({ example: 1 }),
    shares: z.string().openapi({ example: "1000000000" }),
    deposited: z.string().openapi({ example: "1000000000" }),
    lastClaimedEpoch: z.number().openapi({ example: 3 }),
    updatedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
  })),
  totalDeposited: z.string().openapi({ example: "1000000000" }),
});

const epochSchema = z.object({
  id: z.number().openapi({ example: 1 }),
  vaultId: z.number().openapi({ example: 1 }),
  epoch: z.number().openapi({ example: 5 }),
  yieldAmount: z.string().openapi({ example: "25000000" }),
  totalShares: z.string().openapi({ example: "950000000000" }),
  distributedAt: z.string().nullable().openapi({ example: "2026-09-20T00:00:00.000Z" }),
});

const shareBalanceHistorySchema = z.object({
  epoch: z.number().openapi({ example: 5 }),
  shares: z.string().openapi({ example: "1000000000" }),
  recordedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
});

/** #1071 — yieldPerShare is fixed-point, so a string is the only lossless form. */
const epochYieldPerShareSchema = z.object({
  epochId: z.number().openapi({ example: 5 }),
  yieldPerShare: z.string().openapi({ example: "0.000000000263157895" }),
  decimals: z.number().openapi({ example: 18 }),
});

/** #1073 — the window statistics are kept alongside the score that flagged it. */
const epochAnomalySchema = z.object({
  epoch: z.number().openapi({ example: 12 }),
  yieldAmount: z.string().openapi({ example: "25000000" }),
  meanYield: z.string().openapi({ example: "24700000.0" }),
  stddevYield: z.string().openapi({ example: "90000.0" }),
  zScore: z.string().nullable().openapi({ example: "3.4" }),
  sampleSize: z.number().openapi({ example: 30 }),
  detectedAt: z.string().openapi({ example: "2026-09-20T04:00:00.000Z" }),
});

/** #1074 — amounts are strings for the same reason as yieldPerShare. */
const transferVolumeSchema = z.object({
  period: z.string().openapi({ example: "7d" }),
  transferCount: z.number().openapi({ example: 4 }),
  totalVolume: z.string().openapi({ example: "13000" }),
  uniqueSenders: z.number().openapi({ example: 3 }),
  uniqueRecipients: z.number().openapi({ example: 4 }),
});

const redemptionRequestSchema = z.object({
  id: z.number().openapi({ example: 1 }),
  userAddress: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
  shares: z.string().openapi({ example: "500000000" }),
  requestTime: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
});

const adminStatsSchema = z.object({
  vaultCount: z.number().openapi({ example: 12 }),
  userCount: z.number().openapi({ example: 340 }),
  totalValueLocked: z.string().openapi({ example: "25000000000000" }),
  epochCount: z.number().openapi({ example: 48 }),
  archiveSizeBytes: z.number().openapi({ example: 102400 }),
});

const indexerStatusSchema = z.object({
  running: z.boolean().openapi({ example: true }),
  lastLedger: z.number().openapi({ example: 12345678 }),
  lastTickAt: z.string().nullable().openapi({ example: "2026-09-20T00:00:00.000Z" }),
  eventsIndexed: z.number().openapi({ example: 9876 }),
});

const errorResponseSchema = z.object({
  error: z.string().openapi({ example: "NotFound" }),
  message: z.string().openapi({ example: "Vault not found" }),
});

const tvlHistoryPointSchema = z.object({
  totalAssets: z.string().openapi({ example: "1000000000000" }),
  totalSupply: z.string().openapi({ example: "950000000000" }),
  recordedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
});

const tvlBucketSchema = z.object({
  bucket: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
  avgTotalAssets: z.string().openapi({ example: "1000000000000" }),
  maxTotalAssets: z.string().openapi({ example: "1100000000000" }),
  minTotalAssets: z.string().openapi({ example: "900000000000" }),
});

const vaultGroupBySchema = z.object({
  group: z.string().openapi({ example: "Active" }),
  vaultCount: z.number().openapi({ example: 7 }),
  totalValueLocked: z.string().openapi({ example: "25000000000000" }),
  averageApy: z.number().nullable().openapi({ example: 5.25 }),
});

function registerPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/health",
    summary: "Health check",
    tags: ["Health"],
    responses: {
      200: {
        description: "Server is healthy",
        content: { "application/json": { schema: z.object({ version: z.string().openapi({ example: "0.1.0" }), status: z.string().openapi({ example: "ok" }), uptimeSeconds: z.number().openapi({ example: 3600.42 }) }) } },
      },
      503: {
        description: "Service unavailable",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/health",
    summary: "Health check (versioned alias)",
    tags: ["Health"],
    responses: {
      200: {
        description: "Server is healthy",
        content: { "application/json": { schema: z.object({ version: z.string().openapi({ example: "0.1.0" }), status: z.string().openapi({ example: "ok" }), uptimeSeconds: z.number().openapi({ example: 3600.42 }) }) } },
      },
      503: {
        description: "Service unavailable",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults",
    summary: "List vaults",
    tags: ["Vaults"],
    request: {
      query: z.object({
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
        state: z.string().optional(),
        sort: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of up to 3 `field[:direction]` pairs, e.g. " +
              "`state:asc,total_assets:desc`. Allowed fields: created_at, updated_at, " +
              "total_assets, total_supply, state, name. A field with no explicit " +
              "direction inherits `order`.",
          ),
        order: z.enum(["asc", "desc"]).optional(),
        createdFrom: z
          .string()
          .optional()
          .describe("Inclusive lower bound on creation date (ISO 8601 date or date-time)."),
        createdTo: z
          .string()
          .optional()
          .describe("Inclusive upper bound on creation date (ISO 8601 date or date-time)."),
        minTotalAssets: z
          .string()
          .optional()
          .describe("Inclusive lower bound on total assets, as a non-negative integer string."),
        maxTotalAssets: z
          .string()
          .optional()
          .describe("Inclusive upper bound on total assets, as a non-negative integer string."),
      }),
    },
    responses: {
      200: { description: "Paginated list of vaults", content: { "application/json": { schema: paginatedVaultsSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/count",
    summary: "Get vault count",
    tags: ["Vaults"],
    responses: {
      200: { description: "Total vault count", content: { "application/json": { schema: z.object({ total: z.number().openapi({ example: 12 }) }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}",
    summary: "Get vault by contract ID",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Vault details", content: { "application/json": { schema: vaultSchema } } },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/factory/{factoryId}",
    summary: "List vaults by factory",
    tags: ["Vaults"],
    parameters: [{ name: "factoryId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "List of vaults for factory", content: { "application/json": { schema: z.array(vaultSchema) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/state/live",
    summary: "Get live vault state from chain",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Live vault state", content: { "application/json": { schema: z.object({ state: z.string().openapi({ example: "Active" }) }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/total-assets/live",
    summary: "Get live total assets from chain",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Live total assets", content: { "application/json": { schema: z.object({ totalAssets: z.string().openapi({ example: "1000000000000" }) }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/redemption-queue",
    summary: "Get redemption queue",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Redemption queue", content: { "application/json": { schema: z.array(redemptionRequestSchema) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/snapshot",
    summary: "Get vault snapshot",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Vault snapshot", content: { "application/json": { schema: z.object({ state: z.string().openapi({ example: "Active" }), totalAssets: z.string().openapi({ example: "1000000000000" }), totalSupply: z.string().openapi({ example: "950000000000" }), depositorCount: z.number().openapi({ example: 42 }), epochCount: z.number().openapi({ example: 5 }), lastIndexedAt: z.string().nullable().openapi({ example: "2026-09-20T00:00:00.000Z" }) }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/holders",
    summary: "List active vault holders",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    request: {
      query: z.object({
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
        sort: z.enum(["shares", "deposited"]).optional(),
      }),
    },
    responses: {
      200: { description: "Paginated active holder list", content: { "application/json": { schema: paginatedVaultHoldersSchema } } },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/holders/count",
    summary: "Get active vault holder count",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Active holder count", content: { "application/json": { schema: z.object({ count: z.number().openapi({ example: 42 }) }) } } },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/holders/export.csv",
    summary: "Export active vault holders as CSV",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "CSV attachment with active holders", content: { "text/csv": { schema: z.string() } } },
      401: { description: "Missing, invalid or expired API key", content: { "application/json": { schema: errorResponseSchema } } },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/tvl-history",
    summary: "Get vault TVL history",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    request: {
      query: z.object({
        from: z.string().optional().openapi({ example: "2026-09-01T00:00:00.000Z" }),
        to: z.string().optional().openapi({ example: "2026-09-20T00:00:00.000Z" }),
        bucket: z.enum(["hour", "day", "week"]).optional().openapi({ example: "day" }),
      }),
    },
    responses: {
      200: {
        description: "TVL history (raw points, or per-bucket aggregates when ?bucket is set)",
        content: {
          "application/json": {
            schema: z.union([z.array(tvlHistoryPointSchema), z.array(tvlBucketSchema)]),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/analytics/vaults/group-by",
    summary: "Group vault analytics by category, state, or maturity month",
    tags: ["Analytics"],
    request: {
      query: z.object({
        by: z.enum(["rwa_category", "state", "maturityMonth"]).openapi({ example: "state" }),
      }),
    },
    responses: {
      200: {
        description: "One row per non-empty group",
        content: { "application/json": { schema: z.array(vaultGroupBySchema) } },
      },
      400: {
        description: "Invalid group-by dimension",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/analytics/summary",
    summary: "Get analytics summary",
    tags: ["Analytics"],
    responses: {
      200: {
        description: "Platform analytics summary",
        content: {
          "application/json": {
            schema: z.object({
              totalUsers: z.number().openapi({ example: 340 }),
              totalVaults: z.number().openapi({ example: 12 }),
              totalValueLocked: z.string().openapi({ example: "25000000000000" }),
              totalYieldDistributed: z.string().openapi({ example: "1200000000000" }),
              totalDepositors: z.number().openapi({ example: 300 }),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/analytics/tvl",
    summary: "Get cross-vault TVL aggregate",
    tags: ["Analytics"],
    responses: {
      200: {
        description: "TVL aggregate",
        content: {
          "application/json": {
            schema: z.object({
              totalValueLocked: z.string().openapi({ example: "25000000000000" }),
              activeVaultCount: z.number().openapi({ example: 7 }),
              fundingVaultCount: z.number().openapi({ example: 3 }),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/fees",
    summary: "Get operator fee summary per vault",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: {
        description: "Vault fee summary",
        content: {
          "application/json": {
            schema: z.object({
              totalOperatorFees: z.string().openapi({ example: "1500000000" }),
              epochCount: z.number().openapi({ example: 5 }),
              averageFeePerEpoch: z.string().openapi({ example: "300000000" }),
              feeBps: z.number().openapi({ example: 200 }),
              earlyRedemptionFeeRevenue: z.string().openapi({ example: "50000000" }),
            }),
          },
        },
      },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/fees/cooperator",
    summary: "Get cooperator fee breakdown per vault",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: {
        description: "Cooperator fee breakdown",
        content: {
          "application/json": {
            schema: z.object({
              cooperatorAddress: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
              cooperatorFeeBps: z.number().openapi({ example: 500 }),
              totalCooperatorFees: z.string().openapi({ example: "75000000" }),
            }),
          },
        },
      },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/users/{address}",
    summary: "Get user by address",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "User details", content: { "application/json": { schema: userSchema } } },
      404: { description: "User not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/users/{address}/portfolio",
    summary: "Get user portfolio",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "User portfolio", content: { "application/json": { schema: userPortfolioSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/users/{address}/share-history",
    summary: "Get user share balance history",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    request: {
      query: z.object({
        vaultId: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Share balance snapshots ordered by epoch", content: { "application/json": { schema: z.array(shareBalanceHistorySchema) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/users/{address}/positions",
    summary: "Get user vault positions",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "User vault positions", content: { "application/json": { schema: z.array(z.object({ id: z.number().openapi({ example: 1 }), userAddress: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }), vaultId: z.number().openapi({ example: 1 }), shares: z.string().openapi({ example: "1000000000" }), deposited: z.string().openapi({ example: "1000000000" }), lastClaimedEpoch: z.number().openapi({ example: 3 }), updatedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }) })) } } },
    },
  });

  const notificationPreferenceSchema = z.object({
    eventType: z.string().openapi({ example: "yield_distributed" }),
    channel: z.string().openapi({ example: "webhook" }),
    enabled: z.boolean().openapi({ example: true }),
    vaultContractId: z.string().nullable().openapi({ example: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" }),
    updatedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/users/{address}/notification-preferences",
    summary: "Get the user's notification preferences",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: {
        description: "All notification preference rows for the user",
        content: {
          "application/json": {
            schema: z.object({ preferences: z.array(notificationPreferenceSchema) }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/users/{address}/notification-preferences",
    summary: "Upsert the user's notification preferences",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.array(
              z.object({
                eventType: z.string(),
                channel: z.string(),
                enabled: z.boolean(),
                vaultContractId: z.string().nullable().optional(),
              }),
            ),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The updated preference rows",
        content: {
          "application/json": {
            schema: z.object({ preferences: z.array(notificationPreferenceSchema) }),
          },
        },
      },
      400: { description: "Unknown event type or malformed body", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  const vaultSubscriptionSchema = z.object({
    contractId: z.string().openapi({ example: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" }),
    events: z.array(z.string()).openapi({ example: ["yield_distributed", "deposit"] }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/users/{address}/subscriptions",
    summary: "List the user's per-vault notification subscriptions",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: {
        description: "Active subscriptions grouped by vault",
        content: {
          "application/json": {
            schema: z.object({ subscriptions: z.array(vaultSubscriptionSchema) }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/users/{address}/subscriptions",
    summary: "Subscribe the user to events for a single vault",
    tags: ["Users"],
    parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }],
    request: {
      body: { content: { "application/json": { schema: vaultSubscriptionSchema } } },
    },
    responses: {
      201: { description: "Subscription created", content: { "application/json": { schema: vaultSubscriptionSchema } } },
      400: { description: "Unknown event type or malformed body", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/users/{address}/subscriptions/{contractId}",
    summary: "Remove all of the user's subscriptions for a vault",
    tags: ["Users"],
    parameters: [
      { name: "address", in: "path", required: true, schema: { type: "string" } },
      { name: "contractId", in: "path", required: true, schema: { type: "string" } },
    ],
    responses: {
      204: { description: "Subscriptions removed" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/yields",
    summary: "List yields",
    tags: ["Yields"],
    request: { query: z.object({ vaultId: z.coerce.number().optional(), epoch: z.coerce.number().optional() }) },
    responses: {
      200: { description: "List of yield distributions", content: { "application/json": { schema: z.array(epochSchema) } } },
    },
  });

  // ── Yield analytics (#1071, #1072, #1073, #1074) ───────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/v1/yields/{contractId}/epochs",
    summary: "List epochs for a vault, optionally windowed and cursor-paginated",
    description:
      "Without a window or page parameter this returns every epoch, as it always has. " +
      "Supplying `from`, `to`, `limit` or `cursor` switches it to a single ascending page; " +
      "when more pages remain the continuation token is returned in the `X-Next-Cursor` " +
      "response header, leaving the body a plain array.",
    tags: ["Yields"],
    parameters: [
      { name: "contractId", in: "path", required: true, schema: { type: "string" } },
      { name: "from", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "Inclusive lowest epoch." },
      { name: "to", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "Inclusive highest epoch." },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 }, description: "Page size. Defaults to 100." },
      { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque token from a previous page's X-Next-Cursor header." },
    ],
    responses: {
      200: {
        description: "Epochs in ascending epoch order",
        headers: {
          "X-Next-Cursor": { description: "Cursor for the next page. Absent on the last page.", schema: { type: "string" } },
          "Link": { description: "RFC 8288 Web Linking with rel=\"next\" for pagination.", schema: { type: "string" } },
        },
        content: { "application/json": { schema: z.array(epochSchema) } },
      },
      400: { description: "Invalid cursor or window" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/yields/{contractId}/epochs/{epochId}/yield-per-share",
    summary: "Get yield per share for one finalized epoch",
    description:
      "Returns the ratio of total yield to total shares for a single epoch. The epoch must be " +
      "finalized; an epoch that does not exist and one that is still open both answer 404, " +
      "since neither can be turned into a correct number yet.",
    tags: ["Yields"],
    parameters: [
      { name: "contractId", in: "path", required: true, schema: { type: "string" } },
      { name: "epochId", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
    ],
    responses: {
      200: { description: "Yield per share", content: { "application/json": { schema: epochYieldPerShareSchema } } },
      404: { description: "Epoch not found or not yet finalized" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/vaults/{contractId}/epoch-anomalies",
    summary: "List epochs whose yield deviated from its rolling mean (requires API key)",
    description:
      "Epochs flagged by the daily anomaly scan, newest first. A flag means the yield sat more " +
      "than three standard deviations away from the mean of that vault's previous 30 epochs — " +
      "either a real change in the underlying asset or an indexing fault worth a look.",
    tags: ["Admin"],
    parameters: [
      { name: "contractId", in: "path", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } },
    ],
    responses: {
      200: { description: "Recorded anomalies, ordered by epoch descending", content: { "application/json": { schema: z.array(epochAnomalySchema) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/transfer-volume",
    summary: "Get share transfer volume for a vault token",
    description:
      "Aggregates the vault's share transfers over a trailing window of UTC calendar days, so " +
      "`7d` covers today plus the six preceding dates. `totalVolume` is a string because share " +
      "amounts exceed the safe-integer range and a JSON number would round them.",
    tags: ["Vaults"],
    parameters: [
      { name: "contractId", in: "path", required: true, schema: { type: "string" } },
      {
        name: "period",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["1d", "7d", "30d"], default: "7d" },
        description: "Trailing window. Defaults to 7d.",
      },
    ],
    responses: {
      200: { description: "Transfer volume totals", content: { "application/json": { schema: transferVolumeSchema } } },
      400: { description: "Unsupported period" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/stats",
    summary: "Get admin stats (requires API key)",
    tags: ["Admin"],
    responses: {
      200: { description: "Admin statistics", content: { "application/json": { schema: adminStatsSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/fees",
    summary: "Get platform-wide fee analytics (requires API key)",
    tags: ["Admin"],
    responses: {
      200: {
        description: "Platform fee analytics",
        content: {
          "application/json": {
            schema: z.object({
              totalOperatorFees: z.string().openapi({ example: "1500000000" }),
              totalEarlyRedemptionFees: z.string().openapi({ example: "50000000" }),
              totalPlatformRevenue: z.string().openapi({ example: "1550000000" }),
              topFeeVaults: z.array(z.object({ contractId: z.string().openapi({ example: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" }), totalFees: z.string().openapi({ example: "750000000" }) })),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/indexer",
    summary: "Get indexer status (requires API key)",
    tags: ["Admin"],
    responses: {
      200: { description: "Indexer status", content: { "application/json": { schema: indexerStatusSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/admin/indexer/backfill",
    summary: "Trigger indexer backfill (requires API key)",
    tags: ["Admin"],
    request: { body: { content: { "application/json": { schema: z.object({ fromLedger: z.number().openapi({ example: 1000000 }), toLedger: z.number().openapi({ example: 1001000 }) }) } } } },
    responses: {
      202: { description: "Backfill queued", content: { "application/json": { schema: z.object({ queued: z.boolean().openapi({ example: true }), fromLedger: z.number().openapi({ example: 1000000 }), toLedger: z.number().openapi({ example: 1001000 }) }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/events",
    summary: "Get indexed events (requires API key)",
    tags: ["Admin"],
    responses: {
      200: { description: "Indexed events", content: { "application/json": { schema: z.array(z.object({ id: z.number().openapi({ example: 1 }), ledger: z.number().openapi({ example: 12345678 }), txHash: z.string().openapi({ example: "abc123def456" }), contractId: z.string().openapi({ example: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" }), eventType: z.string().openapi({ example: "deposit" }), createdAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }) })) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/vaults/{contractId}/audit",
    summary: "Get vault audit trail (requires API key)",
    tags: ["Admin"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Vault audit trail", content: { "application/json": { schema: z.object({ data: z.array(z.any()).openapi({ example: [] }), total: z.number().openapi({ example: 0 }), limit: z.number().openapi({ example: 20 }), offset: z.number().openapi({ example: 0 }) }) } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/webhooks",
    summary: "Create webhook (requires API key)",
    tags: ["Webhooks"],
    request: { body: { content: { "application/json": { schema: z.object({ url: z.string().openapi({ example: "https://example.com/webhook" }), events: z.array(z.string()).openapi({ example: ["yield_distributed"] }), secret: z.string().optional().openapi({ example: "s3cr3t" }), priority: z.number().int().optional().openapi({ example: 0 }), maxPerHour: z.number().int().positive().nullable().optional().openapi({ example: 100 }) }) } } } },
    responses: {
      201: { description: "Webhook created", content: { "application/json": { schema: z.object({ id: z.number().openapi({ example: 1 }), url: z.string().openapi({ example: "https://example.com/webhook" }), events: z.array(z.string()).openapi({ example: ["yield_distributed"] }), active: z.boolean().openapi({ example: true }), createdAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }), priority: z.number().openapi({ example: 0 }), fallbackChannel: z.number().nullable().openapi({ example: null }), maxPerHour: z.number().nullable().openapi({ example: 100 }) }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/webhooks",
    summary: "List webhooks (requires API key), ordered by priority ascending",
    tags: ["Webhooks"],
    responses: {
      200: { description: "List of webhooks", content: { "application/json": { schema: z.array(z.object({ id: z.number().openapi({ example: 1 }), url: z.string().openapi({ example: "https://example.com/webhook" }), events: z.array(z.string()).openapi({ example: ["yield_distributed"] }), active: z.boolean().openapi({ example: true }), createdAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }), priority: z.number().openapi({ example: 0 }), fallbackChannel: z.number().nullable().openapi({ example: null }), maxPerHour: z.number().nullable().openapi({ example: 100 }) })) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/notifications/health",
    summary: "Ping each active webhook channel (requires API key)",
    tags: ["Webhooks"],
    responses: {
      200: {
        description: "Per-channel reachability",
        content: {
          "application/json": {
            schema: z.object({
              channels: z.array(
                z.object({
                  id: z.number().openapi({ example: 1 }),
                  url: z.string().openapi({ example: "https://example.com/webhook" }),
                  reachable: z.boolean().openapi({ example: true }),
                  latencyMs: z.number().nullable().openapi({ example: 42 }),
                }),
              ),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/admin/notifications/preview",
    summary: "Render a notification template against a sample payload (requires admin API key)",
    tags: ["Webhooks"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              eventType: z.string().openapi({ example: "yield_distributed" }),
              channel: z.string().openapi({ example: "webhook" }),
              samplePayload: z.record(z.unknown()),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Rendered message body", content: { "application/json": { schema: z.object({ rendered: z.string().openapi({ example: "Yield of 25000000 distributed for epoch 5" }) }) } } },
      404: { description: "No template for the (eventType, channel) pair", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/webhooks/{id}",
    summary: "Delete webhook (requires API key)",
    tags: ["Webhooks"],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      204: { description: "Webhook deleted" },
      404: { description: "Webhook not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/factory/admin-history",
    summary: "Get factory admin transfer history (requires API key)",
    tags: ["Factory"],
    responses: {
      200: {
        description: "Admin transfer history, most recent first",
        content: {
          "application/json": {
            schema: z.array(
              z.object({
                oldAdmin: z.string().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
                newAdmin: z.string().openapi({ example: "GDEFGH1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCE" }),
                ledger: z.number().openapi({ example: 12345678 }),
                recordedAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
              }),
            ),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/validate",
    summary: "Validate a request body against a route's schema without executing it",
    description:
      "Dry run: performs exactly the validation the target route performs and nothing else. "
      + "Returns 404 when no schema is registered for the given route and method.",
    tags: ["Validation"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              route: z.string().openapi({ example: "/api/v1/webhooks" }),
              method: z.string().openapi({ example: "POST" }),
              body: z.unknown(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Validation result; `errors` is null when the body is valid",
        content: {
          "application/json": {
            schema: z.object({
              valid: z.boolean().openapi({ example: true }),
              errors: z.array(z.record(z.unknown())).nullable(),
            }),
          },
        },
      },
      400: {
        description: "Malformed dry-run request (missing route, method or body)",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No request body schema is registered for that route and method",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/codegen",
    summary: "Generate a curl or TypeScript snippet for calling a documented route",
    description:
      "Uses this OpenAPI document as the template source: path and query parameters, "
      + "request bodies and the \"requires API key\" note are all read from the spec. "
      + "Returns 404 when no documented route matches.",
    tags: ["Codegen"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              route: z.string().openapi({ example: "/api/v1/vaults/{contractId}" }),
              method: z.string().openapi({ example: "GET" }),
              params: z.record(z.unknown()).optional().openapi({ example: { contractId: "CAAA..." } }),
              language: z.enum(["typescript", "curl"]).openapi({ example: "curl" }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The generated snippet and the resolved request URL",
        content: {
          "application/json": {
            schema: z.object({
              language: z.enum(["typescript", "curl"]).openapi({ example: "curl" }),
              method: z.string().openapi({ example: "GET" }),
              url: z.string().openapi({ example: "/api/v1/vaults/CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" }),
              snippet: z.string().openapi({ example: "curl http://localhost:3000/api/v1/vaults/..." }),
            }),
          },
        },
      },
      400: {
        description: "Malformed request (missing route, method or an unsupported language)",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No documented route matches the given route and method",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/factory/vault-creation-rate",
    summary: "Get vault creation rate over rolling windows",
    tags: ["Factory"],
    responses: {
      200: {
        description: "Vault counts created within each rolling window",
        content: {
          "application/json": {
            schema: z.object({ last24h: z.number().openapi({ example: 2 }), last7d: z.number().openapi({ example: 5 }), last30d: z.number().openapi({ example: 12 }) }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/factory/defaults",
    summary: "Get canonical default vault parameters",
    tags: ["Factory"],
    responses: {
      200: {
        description: "Most recently indexed default vault parameters",
        content: {
          "application/json": {
            schema: z.object({
              defaultAsset: z.string().nullable().openapi({ example: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEADQSKZRXGQ6E4DFR" }),
              defaultZkmeVerifier: z.string().nullable().openapi({ example: "CDVBDO2GW7445HWUITG6E437GZERAUYBG4X5HZRQC2ZEFMV3Y5HGDY52" }),
              defaultCooperator: z.string().nullable().openapi({ example: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD" }),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/factory/events",
    summary: "Get factory event log (requires API key)",
    tags: ["Factory"],
    request: {
      query: z.object({
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
    },
    responses: {
      200: {
        description: "Paginated factory event log, most recent ledger first",
        content: {
          "application/json": {
            schema: z.object({
              data: z.array(
                z.object({
                  eventType: z.string().openapi({ example: "vault_created" }),
                  ledger: z.number().openapi({ example: 12345678 }),
                  txHash: z.string().openapi({ example: "abc123def456" }),
                  createdAt: z.string().openapi({ example: "2026-09-20T00:00:00.000Z" }),
                }),
              ),
              total: z.number().openapi({ example: 12 }),
              page: z.number().openapi({ example: 1 }),
              pageSize: z.number().openapi({ example: 20 }),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/factory/operators",
    summary: "Get active factory-level role holders (requires API key)",
    tags: ["Factory"],
    responses: {
      200: {
        description: "Active factory role holders",
        content: {
          "application/json": {
            schema: z.array(
              z.object({
                address: z.string(),
                role: z.string(),
                assignedAt: z.string(),
              }),
            ),
          },
        },
      },
    },
  });
}


registerPaths();

const generator = new OpenApiGeneratorV3(registry.definitions);

export function getOpenApiSpec(): ReturnType<typeof generator.generateDocument> {
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "StellarYield API",
      version: "0.1.0",
      description: "REST API for StellarYield — indexes on-chain events and exposes vault, user, and yield data.",
    },
    servers: [{ url: "/", description: "Base URL" }],
  });
}

export function setupOpenApiRoutes(app: Express): void {
  const spec = getOpenApiSpec();

  app.get("/api/v1/docs/openapi.json", (_req, res) => {
    res.json(spec);
  });

  import("swagger-ui-express").then((swaggerUi) => {
    app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(spec, {
      explorer: true,
      customSiteTitle: "StellarYield API Docs",
    }));
  }).catch(() => {
    // swagger-ui-express not available; skip UI setup
  });
}
