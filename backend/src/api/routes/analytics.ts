import { Router } from "express";
import { z } from "zod";
import {
  getAnalyticsSummary,
  getTvlAggregate,
  getYieldCorrelation,
  getTopPerformingVaults,
  getUnderperformingVaults,
  getApyBenchmark,
  getApyRanking,
} from "../controllers/analytics.js";
import { validateQuery } from "../middleware/validate.js";

const contractIdSchema = z
  .string()
  .length(56)
  .regex(/^C[A-Z2-7]{55}$/, "Invalid vault contract ID");

const yieldCorrelationQuerySchema = z.object({
  vaultA: contractIdSchema,
  vaultB: contractIdSchema,
});

const topUnderperformingQuerySchema = z.object({
  n: z.coerce.number().int().positive().optional().default(5),
  state: z.string().optional(),
});

const rankingQuerySchema = z.object({
  state: z.string().optional(),
});

export const analyticsRouter = Router();

analyticsRouter.get("/summary", getAnalyticsSummary);
analyticsRouter.get("/tvl", getTvlAggregate);
analyticsRouter.get(
  "/yield-correlation",
  validateQuery(yieldCorrelationQuerySchema),
  getYieldCorrelation,
);

// ── Best & worst performing vault endpoints (#983) ─────────────────────────
analyticsRouter.get(
  "/vaults/top-performing",
  validateQuery(topUnderperformingQuerySchema),
  getTopPerformingVaults,
);

analyticsRouter.get(
  "/vaults/underperforming",
  validateQuery(topUnderperformingQuerySchema),
  getUnderperformingVaults,
);

// ── Platform average APY benchmark (#980) ───────────────────────────────────
analyticsRouter.get("/apy/benchmark", getApyBenchmark);

// ── Vault APY ranking (#981) ────────────────────────────────────────────────
analyticsRouter.get(
  "/apy/ranking",
  validateQuery(rankingQuerySchema),
  getApyRanking,
);

