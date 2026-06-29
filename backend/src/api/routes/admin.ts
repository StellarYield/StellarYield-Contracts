import { Router } from "express";
import { getAdminStats, getAdminIndexer, getAdminEvents, getVaultAudit, backfillIndexer, deleteApiKey, getApiKeys, getWebhookDeliveries, getArchivedVaults, getTotalSupplyConsistency, getDbStats } from "../controllers/admin.js";
import { requireApiKey } from "../middleware/auth.js";

export const adminRouter = Router();

adminRouter.use(requireApiKey({ role: "admin" }));

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/indexer", getAdminIndexer);
adminRouter.post("/indexer/backfill", backfillIndexer);
adminRouter.get("/events", getAdminEvents);
adminRouter.get("/vaults/:contractId/audit", getVaultAudit);
adminRouter.get("/vaults/archived", getArchivedVaults);
adminRouter.get("/consistency/total-supply", getTotalSupplyConsistency);
adminRouter.get("/api-keys", getApiKeys);
adminRouter.delete("/api-keys/:id", deleteApiKey);
adminRouter.get("/webhooks/:id/deliveries", getWebhookDeliveries);
adminRouter.get("/db/stats", getDbStats);
