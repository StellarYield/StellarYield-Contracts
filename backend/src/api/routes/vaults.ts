import { Router } from "express";
import { z } from "zod";
import {
  listVaults,
  getVaultCount,
  listVaultsByFactory,
  getVault,
  getVaultLiveState,
  getVaultLiveTotalAssets,
  getVaultPositions,
  getRedemptionQueue,
  getVaultSnapshot,
  getVaultTopHolders,
  getVaultHolders,
  getVaultTvlHistory,
  getEarlyRedemptionFee,
  exportVaultCsv,
} from "../controllers/vaults.js";
import { validateParams, validateQuery } from "../middleware/validate.js";

const contractAddressSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);

const listVaultsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
  state: z.string().optional(),
  sort: z.enum(["created_at", "total_assets"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

const vaultParamsSchema = z.object({
  contractId: contractAddressSchema,
});

const vaultFactoryParamsSchema = z.object({
  factoryId: contractAddressSchema,
});

export const vaultsRouter = Router();

vaultsRouter.get("/", validateQuery(listVaultsQuerySchema), listVaults);
vaultsRouter.get("/count", getVaultCount);
vaultsRouter.get("/factory/:factoryId", validateParams(vaultFactoryParamsSchema), listVaultsByFactory);
vaultsRouter.get("/:contractId", validateParams(vaultParamsSchema), getVault);
vaultsRouter.get("/:contractId/state/live", validateParams(vaultParamsSchema), getVaultLiveState);
vaultsRouter.get("/:contractId/total-assets/live", validateParams(vaultParamsSchema), getVaultLiveTotalAssets);
vaultsRouter.get("/:contractId/redemption-queue", validateParams(vaultParamsSchema), getRedemptionQueue);
// Get top N holders leaderboard: GET /api/v1/vaults/:contractId/holders/top?n=10
vaultsRouter.get("/:contractId/holders/top", validateParams(vaultParamsSchema), getVaultTopHolders);
// Search holders by partial address: GET /api/v1/vaults/:contractId/holders?search=
vaultsRouter.get("/:contractId/holders", validateParams(vaultParamsSchema), getVaultHolders);
// Get vault snapshot: GET /api/v1/vaults/:contractId/snapshot
vaultsRouter.get("/:contractId/snapshot", validateParams(vaultParamsSchema), getVaultSnapshot);
// Get vault TVL history: GET /api/v1/vaults/:contractId/tvl-history
vaultsRouter.get("/:contractId/tvl-history", validateParams(vaultParamsSchema), getVaultTvlHistory);
// Early redemption fee preview: GET /api/v1/vaults/:contractId/early-redemption-fee?shares=
vaultsRouter.get(
  "/:contractId/early-redemption-fee",
  validateParams(vaultParamsSchema),
  getEarlyRedemptionFee,
);
// Export vault data as CSV: GET /api/v1/vaults/:contractId/export.csv
vaultsRouter.get("/:contractId/export.csv", validateParams(vaultParamsSchema), exportVaultCsv);
