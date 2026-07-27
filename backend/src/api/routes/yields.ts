import { Router } from "express";
import { z } from "zod";
import {
  getVaultEpochs,
  getEpochDetail,
  getBulkEpochs,
  getUserPendingYield,
  getYieldSummary,
  getYieldPerShareHistory,
  getYieldTimeline,
  compareEpochs,
  getNextEpochProjection,
} from "../controllers/yields.js";
import { getYieldsStream } from "../controllers/yields-stream.js";
import { validateQuery, validateParams } from "../middleware/validate.js";
import { sseLimitPerIp } from "../middleware/sseLimitPerIp.js";

// Yield amounts exceed Number.MAX_SAFE_INTEGER, so BigInt-safe strings are kept
// as strings all the way to the ::numeric cast rather than coerced to a number.
const nonNegativeAmountSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer");

const epochQuerySchema = z
  .object({
    epoch: z.coerce.number().int().positive().optional(),
    // Yield amount range; either bound may stand alone (#858).
    minYield: nonNegativeAmountSchema.optional(),
    maxYield: nonNegativeAmountSchema.optional(),
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
  });

const epochDetailParamsSchema = z.object({
  contractId: z.string(),
  epoch: z.coerce.number().int().positive(),
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

// ── Epoch comparison (#820) ──────────────────────────────────────────────────
const epochCompareQuerySchema = z.object({
  a: z.coerce.number().int().positive(),
  b: z.coerce.number().int().positive(),
});
yieldsRouter.get("/:contractId/epochs/compare", validateQuery(epochCompareQuerySchema), compareEpochs);

// ── Next epoch projection (#821) ─────────────────────────────────────────────
yieldsRouter.get("/:contractId/next-epoch-projection", getNextEpochProjection);

yieldsRouter.get("/:contractId/yield-per-share-history", validateQuery(yieldHistoryQuerySchema), getYieldPerShareHistory);
yieldsRouter.get("/:contractId/pending/:userAddress", getUserPendingYield);

const timelineQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

yieldsRouter.get("/:contractId/timeline", validateQuery(timelineQuerySchema), getYieldTimeline);
