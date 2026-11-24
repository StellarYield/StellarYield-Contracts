import { Router } from "express";
import {
  getPlatformTvl,
  getPlatformTvlHistory,
  getPlatformUsersCount,
  getPlatformFlows,
  getUserVaultActivity,
} from "../controllers/platformStats.js";
import { normalizeAddressParam } from "../middleware/normalizeAddressParams.js";

/** Public, mounted at /api/v1/platform. */
export const platformStatsRouter = Router();
platformStatsRouter.get("/tvl", getPlatformTvl); // #1084
platformStatsRouter.get("/tvl/history", getPlatformTvlHistory); // #1085
platformStatsRouter.get("/users/count", getPlatformUsersCount); // #1086
platformStatsRouter.get("/flows", getPlatformFlows); // #1087

/** Public, mounted at /api/v1/users; the path has a second segment so it never shadows /:address. */
export const userVaultActivityRouter = Router();
userVaultActivityRouter.param("address", normalizeAddressParam("address"));
userVaultActivityRouter.get("/:address/vault-activity", getUserVaultActivity); // #1083
