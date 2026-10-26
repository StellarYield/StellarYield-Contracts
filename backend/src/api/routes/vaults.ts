import { Router } from "express";
import { z } from "zod";
import {
  listVaults,
  getVaultAggregates,
  getVaultCount,
  listVaultsByFactory,
  getVault,
  getVaultLiveState,
  getVaultLiveTotalAssets,
  getRedemptionQueue,
  getVaultSnapshotWithRatios,
  getHoldingDuration,
  getFundingVelocity,
  getRedemptionQueueEta,
  getMaturityCountdown,
  getRedemptionStats,
  getRedemptionCancellationRate,
  getHolderRetention,
  getVaultMetadataHistory,
  getWhitelistHistory,
  getVaultStatusHistory,
  getTransferVolume,
  getVaultTopHolders,
  getVaultHolders,
  getVaultHolderCount,
  exportVaultHoldersCsv,
  getVaultTvlHistory,
  getVaultTvlGrowth,
  getVaultFlowsDaily,
  getEarlyRedemptionFee,
  exportVaultCsv,
  getVaultOperators,
  getOperatorLog,
  getCompoundProjection,
  getVaultAnnualReport,
  getEpochBreakdown,
  listCategories,
  searchVaults,
  checkVaultName,
  getTrendingVaults,
  getNewVaults,
  getMaturingSoonVaults,
  getFullyFundedVaults,
  getSimilarVaults,
  getFeeHistory,
  getVaultFees,
  getVaultTransferFees,
  getVaultTransferLeaderboard,
  getCooperatorFees,
  streamVaultEvents,
  getVaultsBulkStatus,
  validateVaultMetadata,
  getDepositDistribution,
  getVaultCohorts,
  getHoldingDuration,
  getVaultSnapshotWithRatios,
  getFundingVelocity,
  getRedemptionQueueEta,
  getMaturityCountdown,
  getRedemptionStats,
  getRedemptionCancellationRate,
  getHolderRetention,
} from "../controllers/vaults.js";
import {
  translateSimulationError,
  simulateFundingProgress,
  simulateMultiOperation,
} from "../controllers/simulate.js";
import { validateParams, validateQuery, validateBody } from "../middleware/validate.js";
import { requireApiKey, enforceApiKeyContractScope, optionalApiKey } from "../middleware/auth.js";
import { validateParams, validateQuery, validateBody, nfcStringSchema, contractAddressSchema } from "../middleware/validate.js";
import { requireApiKey, enforceApiKeyContractScope } from "../middleware/auth.js";
import { simulateLimiter } from "../middleware/rateLimit.js";
import { captureForStaleFallback } from "../middleware/staleResponse.js";
import { parseVaultSort } from "../../services/vault.js";

// Accepts a calendar date (2025-01-31) or a full ISO 8601 date-time, with or
// without an offset.
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Validate an ISO 8601 date or date-time string.
 *
 * The calendar round-trip is required because `Date.parse` silently rolls
 * overflowing components over — "2025-02-30" becomes March 2 rather than NaN —
 * so the shape check alone would let impossible dates through.
 */
function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return false;
  }

  // Catches out-of-range time components such as T25:00:00Z.
  return !Number.isNaN(Date.parse(value));
}

const isoDateSchema = z.string().refine(isValidIsoDate, {
  message: "must be an ISO 8601 date (YYYY-MM-DD) or date-time",
});

// Token amounts exceed Number.MAX_SAFE_INTEGER, so BigInt-safe strings are kept
// as strings all the way to the ::numeric cast rather than coerced to a number.
const nonNegativeAmountSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer");

export const listVaultsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
    state: z.string().optional(),
    category: z.string().optional(),
    cursor: z.string().optional(),
    // Comma-separated `field[:direction]` list, e.g. `state:asc,total_assets:desc` (#855).
    // A bare field name (`?sort=total_assets`) still takes its direction from `order`.
    sort: z.string().optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
    // Creation date range; either bound may stand alone for an open-ended filter (#856).
    createdFrom: isoDateSchema.optional(),
    createdTo: isoDateSchema.optional(),
    // Total assets (TVL) range; either bound may stand alone (#857).
    minTotalAssets: nonNegativeAmountSchema.optional(),
    maxTotalAssets: nonNegativeAmountSchema.optional(),
    q: z.string().optional(),
    // Compound filter tree as JSON string (validated in controller)
    filter: z.string().optional(),
    // Comma-separated camelCase fields to include in responses
    fields: z.string().optional(),
    // Filter vaults by admin tag (#1283)
    tag: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sort) {
      const parsed = parseVaultSort(value.sort, value.order);
      if (!parsed.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sort"], message: parsed.message });
      }
    }

    if (
      value.createdFrom !== undefined &&
      value.createdTo !== undefined &&
      Date.parse(value.createdFrom) > Date.parse(value.createdTo)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["createdFrom"],
        message: "createdFrom must not be after createdTo",
      });
    }

    if (
      value.minTotalAssets !== undefined &&
      value.maxTotalAssets !== undefined &&
      BigInt(value.minTotalAssets) > BigInt(value.maxTotalAssets)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minTotalAssets"],
        message: "minTotalAssets must not be greater than maxTotalAssets",
      });
    }
  });

export const vaultParamsSchema = z.object({
  contractId: contractAddressSchema,
});

const vaultFactoryParamsSchema = z.object({
  factoryId: contractAddressSchema,
});

const vaultHoldersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
  sort: z.enum(["shares", "deposited"]).default("shares"),
});

const searchVaultsQuerySchema = z.object({
  q: z
    .string()
    .max(200, "Search query must be at most 200 characters")
    .regex(/^[^\x00-\x1f\x7f]*$/, "Search query must not contain control characters")
    .optional(),
  category: z.string().optional(),
  state: z.string().optional(),
  sort: z.enum(["created_at", "total_assets"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
  fuzzy: z.coerce.boolean().default(false),
});

const newVaultsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

const maturingSoonQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

// Detail endpoint query params: allow `fields` (comma-separated) and `embed` (comma-separated)
export const vaultDetailQuerySchema = z.object({ fields: z.string().optional(), embed: z.string().optional() });

// Metadata history endpoint (#973): page + pageSize (capped at 100)
const metadataHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
});

// Whitelist history endpoint (#1094): same pagination shape as the other
// history endpoints.
const whitelistHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
});

// Share transfer volume (#1074). A closed set of periods rather than a free-form
// day count: the analytics widgets only ever ask for these three, and an
// arbitrary window would make the reported number hard to compare across calls.
const transferVolumeQuerySchema = z.object({
  period: z.enum(["1d", "7d", "30d"]).default("7d"),
});

// TVL history endpoint (#864): from/to range plus explicit bucket strategy.
const tvlHistoryQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(["hour", "day", "week"]).optional(),
});

export const vaultsRouter = Router();
// Vault scope for keys that carry an `allowed_contract_ids` list (#1243). Runs
// for every route that names a contract, before its handler.
vaultsRouter.param("contractId", enforceApiKeyContractScope);

vaultsRouter.get("/categories", listCategories);
// Public list and detail reads keep a stale copy for outage fallback (#1254).
vaultsRouter.get("/", optionalApiKey(), validateQuery(listVaultsQuerySchema), captureForStaleFallback, listVaults);
vaultsRouter.get("/count", getVaultCount);
// Aggregates endpoint (placed before dynamic :contractId routes)
const aggregatesQuerySchema = z.object({ state: z.string().optional() });
vaultsRouter.get("/aggregates", validateQuery(aggregatesQuerySchema), getVaultAggregates);
// Search, filter, and discovery endpoints (#640–#643, #644, #645)
vaultsRouter.get("/search", validateQuery(searchVaultsQuerySchema), searchVaults);
vaultsRouter.get("/name-check", checkVaultName);
vaultsRouter.get("/trending", getTrendingVaults);
vaultsRouter.get("/new", validateQuery(newVaultsQuerySchema), getNewVaults);
vaultsRouter.get("/maturing-soon", validateQuery(maturingSoonQuerySchema), getMaturingSoonVaults);
vaultsRouter.get("/fully-funded", getFullyFundedVaults);
vaultsRouter.get("/stream", streamVaultEvents);
// Issue #998: Bulk vault status query (placed before /:contractId routes)
export const bulkStatusBodySchema = z.object({
  contractIds: z.array(contractAddressSchema).min(1).max(100),
});
vaultsRouter.post("/bulk/status", validateBody(bulkStatusBodySchema), getVaultsBulkStatus);
// Issue #1015: Simulation error translation (placed before /:contractId routes)
export const translateErrorBodySchema = z.object({ errorCode: z.number().int() });
vaultsRouter.post(
  "/simulate/translate-error",
  simulateLimiter,
  validateBody(translateErrorBodySchema),
  translateSimulationError,
);
// Issue #976: Vault metadata validation
export const metadataValidationSchema = z.object({
  name: nfcStringSchema.optional(),
  documentUri: z.string().optional(),
  logoUri: z.string().optional(),
  description: nfcStringSchema.optional(),
});
vaultsRouter.post("/metadata/validate", validateBody(metadataValidationSchema), validateVaultMetadata);
vaultsRouter.get("/factory/:factoryId", validateParams(vaultFactoryParamsSchema), listVaultsByFactory);
// Issue #1012: Funding progress simulation
vaultsRouter.get(
  "/:contractId/simulate/funding",
  simulateLimiter,
  validateParams(vaultParamsSchema),
  simulateFundingProgress,
);
// Issue #1013: Multi-operation simulation
vaultsRouter.post(
  "/:contractId/simulate",
  simulateLimiter,
  validateParams(vaultParamsSchema),
  simulateMultiOperation,
);
vaultsRouter.get(
  "/:contractId",
  validateParams(vaultParamsSchema),
  validateQuery(vaultDetailQuerySchema),
  captureForStaleFallback,
  getVault,
);
vaultsRouter.get("/:contractId/state/live", validateParams(vaultParamsSchema), getVaultLiveState);
vaultsRouter.get("/:contractId/total-assets/live", validateParams(vaultParamsSchema), getVaultLiveTotalAssets);
vaultsRouter.get("/:contractId/redemption-queue", validateParams(vaultParamsSchema), getRedemptionQueue);
// Get top N holders leaderboard: GET /api/v1/vaults/:contractId/holders/top?n=10
vaultsRouter.get("/:contractId/holders/top", validateParams(vaultParamsSchema), getVaultTopHolders);
// Active holder count: GET /api/v1/vaults/:contractId/holders/count
vaultsRouter.get("/:contractId/holders/count", validateParams(vaultParamsSchema), getVaultHolderCount);
// Export active holders as CSV: GET /api/v1/vaults/:contractId/holders/export.csv
vaultsRouter.get(
  "/:contractId/holders/export.csv",
  requireApiKey(),
  validateParams(vaultParamsSchema),
  exportVaultHoldersCsv,
);
// List active holders: GET /api/v1/vaults/:contractId/holders?page=&pageSize=&sort=
vaultsRouter.get(
  "/:contractId/holders",
  validateParams(vaultParamsSchema),
  validateQuery(vaultHoldersQuerySchema),
  getVaultHolders,
);
// Get vault snapshot: GET /api/v1/vaults/:contractId/snapshot
// Issue #1267: snapshot now includes withdrawalRatio7d and withdrawalRatio30d
vaultsRouter.get("/:contractId/snapshot", validateParams(vaultParamsSchema), getVaultSnapshotWithRatios);
// Issue #1264: average holding duration: GET /api/v1/vaults/:contractId/holding-duration
vaultsRouter.get("/:contractId/holding-duration", validateParams(vaultParamsSchema), getHoldingDuration);
// Issue #1268: funding velocity: GET /api/v1/vaults/:contractId/funding-velocity
vaultsRouter.get("/:contractId/funding-velocity", validateParams(vaultParamsSchema), getFundingVelocity);
// Issue #1269: redemption queue ETA: GET /api/v1/vaults/:contractId/redemption-queue/:address/eta
vaultsRouter.get(
  "/:contractId/redemption-queue/:address/eta",
  validateParams(z.object({ contractId: contractAddressSchema, address: z.string().min(1) })),
  getRedemptionQueueEta,
);
// Metadata change history: GET /api/v1/vaults/:contractId/metadata-history (#973)
vaultsRouter.get(
  "/:contractId/metadata-history",
  validateParams(vaultParamsSchema),
  validateQuery(metadataHistoryQuerySchema),
  getVaultMetadataHistory,
);
// Whitelist change history: GET /api/v1/vaults/:contractId/whitelist-history (#1094)
vaultsRouter.get(
  "/:contractId/whitelist-history",
  validateParams(vaultParamsSchema),
  validateQuery(whitelistHistoryQuerySchema),
  getWhitelistHistory,
);
// Status / manager change history: GET /api/v1/vaults/:contractId/status-history (#1065, #1068)
vaultsRouter.get("/:contractId/status-history", validateParams(vaultParamsSchema), getVaultStatusHistory);
// Share transfer volume for a vault token (#1074):
// GET /api/v1/vaults/:contractId/transfer-volume?period=1d|7d|30d
vaultsRouter.get(
  "/:contractId/transfer-volume",
  validateParams(vaultParamsSchema),
  validateQuery(transferVolumeQuerySchema),
  getTransferVolume,
);
// Get vault TVL history: GET /api/v1/vaults/:contractId/tvl-history
vaultsRouter.get(
  "/:contractId/tvl-history",
  validateParams(vaultParamsSchema),
  validateQuery(tvlHistoryQuerySchema),
  getVaultTvlHistory,
);
// Get compound projection: GET /api/v1/vaults/:contractId/compound-projection?shares=<amount>&epochs=<n>
vaultsRouter.get("/:contractId/compound-projection", validateParams(vaultParamsSchema), getCompoundProjection);
// Early redemption fee preview: GET /api/v1/vaults/:contractId/early-redemption-fee?shares=
vaultsRouter.get(
  "/:contractId/early-redemption-fee",
  validateParams(vaultParamsSchema),
  getEarlyRedemptionFee,
);
// Operator fee summary per vault: GET /api/v1/vaults/:contractId/fees
vaultsRouter.get("/:contractId/fees", validateParams(vaultParamsSchema), getVaultFees);
// Cooperator fee breakdown: GET /api/v1/vaults/:contractId/fees/cooperator
vaultsRouter.get("/:contractId/fees/cooperator", validateParams(vaultParamsSchema), getCooperatorFees);
// Export vault data as CSV: GET /api/v1/vaults/:contractId/export.csv
vaultsRouter.get("/:contractId/export.csv", validateParams(vaultParamsSchema), exportVaultCsv);
// Operators list: GET /api/v1/vaults/:contractId/operators
vaultsRouter.get("/:contractId/operators", validateParams(vaultParamsSchema), getVaultOperators);
// Operator activity log: GET /api/v1/vaults/:contractId/operators/log
vaultsRouter.get("/:contractId/operators/log", validateParams(vaultParamsSchema), getOperatorLog);
// Fee rate history: GET /api/v1/vaults/:contractId/fees/history (#791)
vaultsRouter.get("/:contractId/fees/history", validateParams(vaultParamsSchema), getFeeHistory);
// Vault detail: GET /api/v1/vaults/:contractId
vaultsRouter.get("/:contractId", validateParams(vaultParamsSchema), getVault);
// Annual vault performance report: GET /api/v1/vaults/:contractId/report?year=2025
vaultsRouter.get("/:contractId/report", validateParams(vaultParamsSchema), getVaultAnnualReport);
// Per-user yield breakdown for a specific epoch: GET /api/v1/vaults/:contractId/epochs/:epoch/breakdown
vaultsRouter.get("/:contractId/epochs/:epoch/breakdown", validateParams(vaultParamsSchema), getEpochBreakdown);
// Similar vaults by category and TVL proximity: GET /api/v1/vaults/:contractId/similar
vaultsRouter.get("/:contractId/similar", validateParams(vaultParamsSchema), getSimilarVaults);
// Transfer fees query: GET /api/v1/vaults/:contractId/transfer-fees?from=&to= (#1076)
vaultsRouter.get("/:contractId/transfer-fees", validateParams(vaultParamsSchema), getVaultTransferFees);
// Transfer leaderboard: GET /api/v1/vaults/:contractId/transfer-leaderboard?limit=10 (#1075)
vaultsRouter.get("/:contractId/transfer-leaderboard", validateParams(vaultParamsSchema), getVaultTransferLeaderboard);
// Maturity countdown: GET /api/v1/vaults/:contractId/maturity-countdown (#1273)
vaultsRouter.get("/:contractId/maturity-countdown", validateParams(vaultParamsSchema), getMaturityCountdown);
// Redemption processing latency stats: GET /api/v1/vaults/:contractId/redemption-stats (#1271)
vaultsRouter.get("/:contractId/redemption-stats", validateParams(vaultParamsSchema), getRedemptionStats);
// Redemption cancellation rate: GET /api/v1/vaults/:contractId/redemption-stats/cancellation (#1272)
vaultsRouter.get("/:contractId/redemption-stats/cancellation", validateParams(vaultParamsSchema), getRedemptionCancellationRate);
// Holder retention across epochs: GET /api/v1/vaults/:contractId/retention?epochs=5 (#1263)
const retentionQuerySchema = z.object({ epochs: z.coerce.number().int().min(1).max(100).default(5) });
vaultsRouter.get("/:contractId/retention", validateParams(vaultParamsSchema), validateQuery(retentionQuerySchema), getHolderRetention);

// Deposit size distribution histogram: GET /api/v1/vaults/:contractId/deposit-distribution?buckets=N (#1265)
const depositDistributionQuerySchema = z.object({
  buckets: z.coerce.number().int().min(2).max(50).default(10),
});
vaultsRouter.get(
  "/:contractId/deposit-distribution",
  validateParams(vaultParamsSchema),
  validateQuery(depositDistributionQuerySchema),
  getDepositDistribution,
);

// Holder cohorts by first-deposit month: GET /api/v1/vaults/:contractId/cohorts (#1266)
vaultsRouter.get("/:contractId/cohorts", validateParams(vaultParamsSchema), getVaultCohorts);

// Issue #1260: TVL growth rate: GET /api/v1/vaults/:contractId/tvl/growth
vaultsRouter.get("/:contractId/tvl/growth", validateParams(vaultParamsSchema), getVaultTvlGrowth);

// Issue #1261: Net deposits per day: GET /api/v1/vaults/:contractId/flows/daily?from=&to=
vaultsRouter.get("/:contractId/flows/daily", validateParams(vaultParamsSchema), getVaultFlowsDaily);

