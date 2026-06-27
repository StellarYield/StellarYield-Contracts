import { Router } from "express";
import { z } from "zod";
import {
  listVaults,
  getVaultCount,
  listVaultsByFactory,
  getVault,
  getVaultLiveState,
  getVaultLiveTotalAssets,
  getRedemptionQueue,
  getVaultSnapshot,
  getVaultTopHolders,
  getVaultHolders,
  getVaultHolderCount,
  exportVaultHoldersCsv,
  getVaultTvlHistory,
  getEarlyRedemptionFee,
  exportVaultCsv,
  getCompoundProjection,
  getVaultAnnualReport,
  getEpochBreakdown,
  listCategories,
} from "../controllers/vaults.js";
import { validateParams, validateQuery } from "../middleware/validate.js";
import { requireApiKey } from "../middleware/auth.js";

const contractAddressSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);

const listVaultsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
  state: z.string().optional(),
  category: z.string().optional(),
  cursor: z.string().optional(),
  sort: z.enum(["created_at", "total_assets"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().optional(),
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
});

const newVaultsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

export const vaultsRouter = Router();

vaultsRouter.get("/categories", listCategories);
vaultsRouter.get("/", validateQuery(listVaultsQuerySchema), listVaults);
vaultsRouter.get("/count", getVaultCount);
vaultsRouter.get("/factory/:factoryId", validateParams(vaultFactoryParamsSchema), listVaultsByFactory);
vaultsRouter.get("/:contractId", validateParams(vaultParamsSchema), getVault);
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
// Export vault data as CSV: GET /api/v1/vaults/:contractId/export.csv
vaultsRouter.get("/:contractId/export.csv", validateParams(vaultParamsSchema), exportVaultCsv);
// Annual vault performance report: GET /api/v1/vaults/:contractId/report?year=2025
vaultsRouter.get("/:contractId/report", validateParams(vaultParamsSchema), getVaultAnnualReport);
// Per-user yield breakdown for a specific epoch: GET /api/v1/vaults/:contractId/epochs/:epoch/breakdown
vaultsRouter.get("/:contractId/epochs/:epoch/breakdown", validateParams(vaultParamsSchema), getEpochBreakdown);
