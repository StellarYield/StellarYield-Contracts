import { Router } from "express";
import { listVaults, getVault } from "../../controllers/vaults.js";
import { validateParams, validateQuery } from "../../middleware/validate.js";
import { normalizeAddressParam } from "../../middleware/normalizeAddressParams.js";
import {
  listVaultsQuerySchema,
  vaultParamsSchema,
  vaultDetailQuerySchema,
} from "../vaults.js";

/**
 * /api/v2/vaults namespace scaffold.
 *
 * v2 endpoints are added here as they are designed. Until a route gets a
 * dedicated v2 implementation it delegates to the v1 controller so clients can
 * start targeting the v2 prefix. Every response carries `API-Version: 2`.
 */
export const vaultsV2Router = Router();
vaultsV2Router.param("contractId", normalizeAddressParam("contractId"));

vaultsV2Router.use((_req, res, next) => {
  res.setHeader("API-Version", "2");
  next();
});

vaultsV2Router.get("/", validateQuery(listVaultsQuerySchema), listVaults);
vaultsV2Router.get(
  "/:contractId",
  validateParams(vaultParamsSchema),
  validateQuery(vaultDetailQuerySchema),
  getVault,
);

vaultsV2Router.use((req, res) => {
  res.status(404).json({
    error: "Not implemented in v2",
    path: req.originalUrl,
    fallback: req.originalUrl.replace("/api/v2/", "/api/v1/"),
  });
});
