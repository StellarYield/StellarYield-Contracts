import { Router } from "express";
import {
  getPlatformFees,
  getFeeAccrualEstimate,
  getFeeRevenue,
  listFeeRebates,
  listFeeTiers,
  createFeeRebate,
  createFeeTier,
  deleteFeeTier,
} from "../controllers/fees.js";
import { requireApiKey } from "../middleware/auth.js";
import { normalizeAddressParam } from "../middleware/normalizeAddressParams.js";
import { requireApiKey, enforceApiKeyContractScope } from "../middleware/auth.js";

/** Public: GET /api/v1/platform/fees (#1101). */
export const platformFeesRouter = Router();
platformFeesRouter.get("/fees", getPlatformFees);

/**
 * Public, mounted alongside vaultsRouter under /api/v1/vaults. Every path has a
 * second segment, so none of them shadows a `/:contractId` vault route.
 */
export const vaultFeesRouter = Router();
vaultFeesRouter.param("contractId", normalizeAddressParam("contractId"));
vaultFeesRouter.param("contractId", enforceApiKeyContractScope); // #1243
vaultFeesRouter.get("/:contractId/fee-accrual-estimate", getFeeAccrualEstimate); // #1102
vaultFeesRouter.get("/:contractId/fee-rebates", listFeeRebates); // #1103
vaultFeesRouter.get("/:contractId/fee-revenue", getFeeRevenue); // #1104
vaultFeesRouter.get("/:contractId/fee-tiers", listFeeTiers); // #1099

/**
 * Mounted inside adminRouter at /vaults, so it inherits the admin IP allowlist
 * and API-key check; the mutating routes additionally require the admin role.
 */
export const adminFeesRouter = Router();
adminFeesRouter.param("contractId", normalizeAddressParam("contractId"));
adminFeesRouter.post("/:contractId/fee-rebates", requireApiKey({ role: "admin" }), createFeeRebate); // #1103
adminFeesRouter.post("/:contractId/fee-tiers", requireApiKey({ role: "admin" }), createFeeTier); // #1099
adminFeesRouter.delete("/:contractId/fee-tiers/:tierId", requireApiKey({ role: "admin" }), deleteFeeTier); // #1099
