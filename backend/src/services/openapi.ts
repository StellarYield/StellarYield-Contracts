import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import type { Express } from "express";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const vaultStateSchema = z.enum(["Funding", "Active", "Matured", "Closed", "Cancelled"]);

const vaultSchema = z.object({
  id: z.number(),
  contractId: z.string(),
  factoryId: z.string().nullable(),
  asset: z.string(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  state: vaultStateSchema,
  totalAssets: z.string(),
  totalSupply: z.string(),
  depositorCount: z.number(),
  fundingTarget: z.string().nullable(),
  fundingDeadline: z.string().nullable(),
  fundingProgress: z.number().nullable(),
  minDeposit: z.string().nullable(),
  maxDepositPerUser: z.string().nullable(),
  rwaName: z.string().nullable().optional(),
  rwaSymbol: z.string().nullable().optional(),
  rwaDocumentUri: z.string().nullable().optional(),
  rwaCategory: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  logoUri: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const paginatedVaultsSchema = z.object({
  data: z.array(vaultSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const vaultHolderSchema = z.object({
  userAddress: z.string(),
  shares: z.string(),
  deposited: z.string(),
  lastUpdatedAt: z.string(),
});

const paginatedVaultHoldersSchema = z.object({
  data: z.array(vaultHolderSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const userSchema = z.object({
  id: z.number(),
  address: z.string(),
  kycVerified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const userPortfolioSchema = z.object({
  positions: z.array(z.object({
    id: z.number(),
    userAddress: z.string(),
    vaultId: z.number(),
    shares: z.string(),
    deposited: z.string(),
    lastClaimedEpoch: z.number(),
    updatedAt: z.string(),
  })),
  totalDeposited: z.string(),
});

const epochSchema = z.object({
  id: z.number(),
  vaultId: z.number(),
  epoch: z.number(),
  yieldAmount: z.string(),
  totalShares: z.string(),
  distributedAt: z.string().nullable(),
});

const shareBalanceHistorySchema = z.object({
  epoch: z.number(),
  shares: z.string(),
  recordedAt: z.string(),
});

const redemptionRequestSchema = z.object({
  id: z.number(),
  userAddress: z.string(),
  shares: z.string(),
  requestTime: z.string(),
});

const adminStatsSchema = z.object({
  vaultCount: z.number(),
  userCount: z.number(),
  totalValueLocked: z.string(),
  epochCount: z.number(),
  archiveSizeBytes: z.number(),
});

const indexerStatusSchema = z.object({
  running: z.boolean(),
  lastLedger: z.number(),
  lastTickAt: z.string().nullable(),
  eventsIndexed: z.number(),
});

const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
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
        content: { "application/json": { schema: z.object({ version: z.string(), status: z.string() }) } },
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
      200: { description: "Total vault count", content: { "application/json": { schema: z.object({ total: z.number() }) } } },
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
      200: { description: "Live vault state", content: { "application/json": { schema: z.object({ state: z.string() }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/total-assets/live",
    summary: "Get live total assets from chain",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Live total assets", content: { "application/json": { schema: z.object({ totalAssets: z.string() }) } } },
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
      200: { description: "Vault snapshot", content: { "application/json": { schema: z.object({ state: z.string(), totalAssets: z.string(), totalSupply: z.string(), depositorCount: z.number(), epochCount: z.number(), lastIndexedAt: z.string().nullable() }) } } },
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
      200: { description: "Active holder count", content: { "application/json": { schema: z.object({ count: z.number() }) } } },
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
      401: { description: "Missing API key", content: { "application/json": { schema: errorResponseSchema } } },
      403: { description: "Invalid API key", content: { "application/json": { schema: errorResponseSchema } } },
      404: { description: "Vault not found", content: { "application/json": { schema: errorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/vaults/{contractId}/tvl-history",
    summary: "Get vault TVL history",
    tags: ["Vaults"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "TVL history", content: { "application/json": { schema: z.array(z.object({ totalAssets: z.string(), totalSupply: z.string(), recordedAt: z.string() })) } } },
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
              totalOperatorFees: z.string(),
              epochCount: z.number(),
              averageFeePerEpoch: z.string(),
              feeBps: z.number(),
              earlyRedemptionFeeRevenue: z.string(),
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
              cooperatorAddress: z.string(),
              cooperatorFeeBps: z.number(),
              totalCooperatorFees: z.string(),
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
      200: { description: "User vault positions", content: { "application/json": { schema: z.array(z.object({ id: z.number(), userAddress: z.string(), vaultId: z.number(), shares: z.string(), deposited: z.string(), lastClaimedEpoch: z.number(), updatedAt: z.string() })) } } },
    },
  });

  const notificationPreferenceSchema = z.object({
    eventType: z.string(),
    channel: z.string(),
    enabled: z.boolean(),
    vaultContractId: z.string().nullable(),
    updatedAt: z.string(),
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
    contractId: z.string(),
    events: z.array(z.string()),
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
              totalOperatorFees: z.string(),
              totalEarlyRedemptionFees: z.string(),
              totalPlatformRevenue: z.string(),
              topFeeVaults: z.array(z.object({ contractId: z.string(), totalFees: z.string() })),
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
    request: { body: { content: { "application/json": { schema: z.object({ fromLedger: z.number(), toLedger: z.number() }) } } } },
    responses: {
      202: { description: "Backfill queued", content: { "application/json": { schema: z.object({ queued: z.boolean(), fromLedger: z.number(), toLedger: z.number() }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/events",
    summary: "Get indexed events (requires API key)",
    tags: ["Admin"],
    responses: {
      200: { description: "Indexed events", content: { "application/json": { schema: z.array(z.object({ id: z.number(), ledger: z.number(), txHash: z.string(), contractId: z.string(), eventType: z.string(), createdAt: z.string() })) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/admin/vaults/{contractId}/audit",
    summary: "Get vault audit trail (requires API key)",
    tags: ["Admin"],
    parameters: [{ name: "contractId", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: { description: "Vault audit trail", content: { "application/json": { schema: z.object({ data: z.array(z.any()), total: z.number(), limit: z.number(), offset: z.number() }) } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/webhooks",
    summary: "Create webhook (requires API key)",
    tags: ["Webhooks"],
    request: { body: { content: { "application/json": { schema: z.object({ url: z.string(), events: z.array(z.string()), secret: z.string().optional(), priority: z.number().int().optional(), maxPerHour: z.number().int().positive().nullable().optional() }) } } } },
    responses: {
      201: { description: "Webhook created", content: { "application/json": { schema: z.object({ id: z.number(), url: z.string(), events: z.array(z.string()), active: z.boolean(), createdAt: z.string(), priority: z.number(), fallbackChannel: z.number().nullable(), maxPerHour: z.number().nullable() }) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/webhooks",
    summary: "List webhooks (requires API key), ordered by priority ascending",
    tags: ["Webhooks"],
    responses: {
      200: { description: "List of webhooks", content: { "application/json": { schema: z.array(z.object({ id: z.number(), url: z.string(), events: z.array(z.string()), active: z.boolean(), createdAt: z.string(), priority: z.number(), fallbackChannel: z.number().nullable(), maxPerHour: z.number().nullable() })) } } },
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
                  id: z.number(),
                  url: z.string(),
                  reachable: z.boolean(),
                  latencyMs: z.number().nullable(),
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
              eventType: z.string(),
              channel: z.string(),
              samplePayload: z.record(z.unknown()),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Rendered message body", content: { "application/json": { schema: z.object({ rendered: z.string() }) } } },
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
                oldAdmin: z.string(),
                newAdmin: z.string(),
                ledger: z.number(),
                recordedAt: z.string(),
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
              valid: z.boolean(),
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
              language: z.enum(["typescript", "curl"]),
              method: z.string(),
              url: z.string(),
              snippet: z.string(),
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
            schema: z.object({ last24h: z.number(), last7d: z.number(), last30d: z.number() }),
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
              defaultAsset: z.string().nullable(),
              defaultZkmeVerifier: z.string().nullable(),
              defaultCooperator: z.string().nullable(),
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
                  eventType: z.string(),
                  ledger: z.number(),
                  txHash: z.string(),
                  createdAt: z.string(),
                }),
              ),
              total: z.number(),
              page: z.number(),
              pageSize: z.number(),
            }),
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
