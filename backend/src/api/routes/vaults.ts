import { Router } from "express";
import { z } from "zod";
import {
  listVaults,
  getVaultCount,
  listVaultsByFactory,
  getVaultLiveState,
  getVaultLiveTotalAssets,
  getRedemptionQueue,
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
vaultsRouter.get("/:contractId/state/live", validateParams(vaultParamsSchema), getVaultLiveState);
vaultsRouter.get("/:contractId/total-assets/live", validateParams(vaultParamsSchema), getVaultLiveTotalAssets);
vaultsRouter.get("/:contractId/redemption-queue", validateParams(vaultParamsSchema), getRedemptionQueue);
