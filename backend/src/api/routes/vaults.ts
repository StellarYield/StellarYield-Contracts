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
  getVaultSnapshot,
  getVaultMetadataHistory,
  getVaultTopHolders,
  getVaultHolders,
  getVaultHolderCount,
  exportVaultHoldersCsv,
  getVaultTvlHistory,
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
  getCooperatorFees,
  streamVaultEvents,
  getVaultsBulkStatus,
  validateVaultMetadata,
} from "../controllers/vaults.js";
import {
  translateSimulationError,
  simulateFundingProgress,
  simulateMultiOperation,
} from "../controllers/simulate.js";
import { validateParams, validateQuery, validateBody } from "../middleware/validate.js";
import { requireApiKey } from "../middleware/auth.js";
import { simulateLimiter } from "../middleware/rateLimit.js";
import { parseVaultSort } from "../../services/vault.js";

const contractAddressSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);

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

const listVaultsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
    state: z.string().optional(),
    category: z.string().optional(),
    cursor: z.string().optional(),
    // Comma-separated `field[:direction]` list, e.g. `state:asc,total_assets:desc` (#855).
    // A bare field name (`?sort=total_assets`) still takes its direction from `order`.
    sort: z.string().default("created_at"),
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
  })
  .superRefine((value, ctx) => {
    const parsed = parseVaultSort(value.sort, value.order);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sort"], message: parsed.message });
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

const vaultParamsSchema = z.object({
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
  q: z.string().optional(),
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
const vaultDetailQuerySchema = z.object({ fields: z.string().optional(), embed: z.string().optional() });

// Metadata history endpoint (#973): page + pageSize (capped at 100)
const metadataHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
});

export const vaultsRouter = Router();

vaultsRouter.get("/categories", listCategories);
vaultsRouter.get("/", validateQuery(listVaultsQuerySchema), listVaults);
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
  name: z.string().optional(),
  documentUri: z.string().optional(),
  logoUri: z.string().optional(),
  description: z.string().optional(),
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
vaultsRouter.get("/:contractId", validateParams(vaultParamsSchema), validateQuery(vaultDetailQuerySchema), getVault);
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
vaultsRouter.get("/:contractId/snapshot", validateParams(vaultParamsSchema), getVaultSnapshot);
// Metadata change history: GET /api/v1/vaults/:contractId/metadata-history (#973)
vaultsRouter.get(
  "/:contractId/metadata-history",
  validateParams(vaultParamsSchema),
  validateQuery(metadataHistoryQuerySchema),
  getVaultMetadataHistory,
);
// Get vault TVL history: GET /api/v1/vaults/:contractId/tvl-history
vaultsRouter.get("/:contractId/tvl-history", validateParams(vaultParamsSchema), getVaultTvlHistory);
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
