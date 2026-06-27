import { Router } from "express";
import { getAdminStats, getAdminIndexer, getAdminEvents, getVaultAudit, backfillIndexer, deleteApiKey, getApiKeys } from "../controllers/admin.js";
import { requireApiKey } from "../middleware/auth.js";

export const adminRouter = Router();

adminRouter.use(requireApiKey({ role: "admin" }));

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/indexer", getAdminIndexer);
adminRouter.post("/indexer/backfill", backfillIndexer);
adminRouter.get("/events", getAdminEvents);
// Per-vault audit trail: GET /api/v1/admin/vaults/:contractId/audit
adminRouter.get("/vaults/:contractId/audit", getVaultAudit);
// List API keys: GET /api/v1/admin/api-keys
adminRouter.get("/api-keys", getApiKeys);
// Delete API key: DELETE /api/v1/admin/api-keys/:id
adminRouter.delete("/api-keys/:id", deleteApiKey);
