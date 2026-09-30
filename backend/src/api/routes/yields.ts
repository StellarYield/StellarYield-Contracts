import { Router } from "express";
import { z } from "zod";
import {
  getVaultEpochs,
  getEpochYieldPerShare,
  getEpochDetail,
  getEpochYieldPerShare,
  getBulkEpochs,
  getUserPendingYield,
  getYieldSummary,
  getYieldPerShareHistory,
  getYieldTimeline,
  compareEpochs,
  getNextEpochProjection,
  getApyVsTarget,
  getApyTrend,
  getRollingApy,
  getApyHistory,
  getYieldVolatility,
} from "../controllers/yields.js";
import { getYieldsStream } from "../controllers/yields-stream.js";
import { validateQuery, validateParams } from "../middleware/validate.js";
import { sseLimitPerIp } from "../middleware/sseLimitPerIp.js";

// Yield amounts exceed Number.MAX_SAFE_INTEGER, so BigInt-safe strings are kept
// as strings all the way to the ::numeric cast rather than coerced to a number.
const nonNegativeAmountSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer");

/** Epoch number, a positive integer. Kept as a plain number: epochs are
 * sequential and stay far below 2^53, unlike token amounts. */
const epochNumberSchema = z.coerce.number().int().positive();

/** Upper bound on a batch page (#1072). High enough for a chart of any
 * realistic history, low enough that one request cannot pin the database. */
const EPOCH_PAGE_MAX = 500;

/**
 * Opaque base64url continuation token (#1072).
 *
 * Only the transport encoding is validated here. Decoding happens in the
 * service, which rejects a well-formed token that is stale, foreign, or from a
 * different vault, and the controller turns that into a 400.
 */
const epochCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/, "must be a base64url token");

const epochQuerySchema = z
  .object({
    epoch: z.coerce.number().int().positive().optional(),
    // Yield amount range; either bound may stand alone (#858).
    minYield: nonNegativeAmountSchema.optional(),
    maxYield: nonNegativeAmountSchema.optional(),
    // Multi-epoch batch window with keyset pagination (#1072). Supplying any of
    // these switches the endpoint from an unbounded listing to one page.
    from: epochNumberSchema.optional(),
    to: epochNumberSchema.optional(),
    limit: z.coerce.number().int().min(1).max(EPOCH_PAGE_MAX).optional(),
    cursor: epochCursorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minYield !== undefined &&
      value.maxYield !== undefined &&
      BigInt(value.minYield) > BigInt(value.maxYield)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minYield"],
        message: "minYield must not be greater than maxYield",
      });
    }

    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must not be greater than to",
      });
    }
  });

const epochDetailParamsSchema = z.object({
  contractId: z.string(),
  epoch: z.coerce.number().int().positive(),
});

// #1071 — the per-share ratio for one epoch. Keyed by `epochId` (not `epoch`)
// so the path cannot be confused with GET /:contractId/epochs/:epoch, and
// validated as a positive integer so a non-numeric segment is a 400 rather
// than a silently-coerced NaN lookup.
const epochYieldPerShareParamsSchema = z.object({
  contractId: z.string(),
  epochId: z.coerce.number().int().positive(),
});

const yieldHistoryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((v) => Math.min(v, 200)),
});

export const yieldsRouter = Router();

yieldsRouter.get("/stream", sseLimitPerIp(), getYieldsStream);
yieldsRouter.get("/:contractId/summary", getYieldSummary);
yieldsRouter.get("/:contractId/epochs", validateQuery(epochQuerySchema), getVaultEpochs);
yieldsRouter.get("/:contractId/epochs/bulk", getBulkEpochs);
yieldsRouter.get(
  "/:contractId/epochs/:epoch",
  validateParams(epochDetailParamsSchema),
  getEpochDetail,
);
// Yield-per-share for a single finalized epoch (#1071). Registered after the
// `:epoch` detail route; the paths are distinct, so the ordering is cosmetic.
yieldsRouter.get(
  "/:contractId/epochs/:epochId/yield-per-share",
  validateParams(epochYieldPerShareParamsSchema),
  getEpochYieldPerShare,
);

const epochYieldPerShareParamsSchema = z.object({
  contractId: z.string(),
  epochId: z.coerce.number().int().positive(),
});

yieldsRouter.get(
  "/:contractId/epochs/:epochId/yield-per-share",
  validateParams(epochYieldPerShareParamsSchema),
  getEpochYieldPerShare,
);


// ── Epoch comparison (#820) ──────────────────────────────────────────────────
const epochCompareQuerySchema = z.object({
  a: z.coerce.number().int().positive(),
  b: z.coerce.number().int().positive(),
});
yieldsRouter.get("/:contractId/epochs/compare", validateQuery(epochCompareQuerySchema), compareEpochs);

// ── Next epoch projection (#821) ─────────────────────────────────────────────
yieldsRouter.get("/:contractId/next-epoch-projection", getNextEpochProjection);

// ── APY vs target (#985) ──────────────────────────────────────────────────────
yieldsRouter.get("/:contractId/apy/vs-target", getApyVsTarget);

// ── APY trend indicator (#986) ────────────────────────────────────────────────
yieldsRouter.get("/:contractId/apy/trend", getApyTrend);

// ── Rolling APY calculation (#978) ────────────────────────────────────────────
yieldsRouter.get("/:contractId/apy/rolling", getRollingApy);

// ── APY history time-series (#979) ────────────────────────────────────────────
const apyHistoryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
yieldsRouter.get("/:contractId/apy/history", validateQuery(apyHistoryQuerySchema), getApyHistory);

// ── Yield volatility metric per vault (#982) ──────────────────────────────────
yieldsRouter.get("/:contractId/volatility", getYieldVolatility);

yieldsRouter.get("/:contractId/yield-per-share-history", validateQuery(yieldHistoryQuerySchema), getYieldPerShareHistory);
yieldsRouter.get("/:contractId/pending/:userAddress", getUserPendingYield);

const timelineQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

yieldsRouter.get("/:contractId/timeline", validateQuery(timelineQuerySchema), getYieldTimeline);

