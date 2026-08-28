import { Router } from "express";
import {
  getAdminStats,
  getAdminIndexer,
  getAdminEvents,
  getVaultAudit,
  backfillIndexer,
  deleteApiKey,
  getApiKeys,
  getWebhookDeliveries,
  bulkToggleWebhooks,
  getArchivedVaults,
  getTotalSupplyConsistency,
  getDbStats,
  getAdminFees,
  getAdminFeesDashboard,
  deleteUser,
  getAdminAuditLog,
  getJobStatus,
  getJobQueueDashboard,
  getFailedJobs,
  flagUserAml,
  clearUserAml,
  getFlaggedUsers,
  getPositionsSnapshot,
  streamIndexerProgress,
  getVaultComplianceStatus,
  getUserComplianceSummary,
  getRetentionPolicy,
  patchRetentionPolicy,
  getIndexStats,
  getPoolStats,
  getBenchmarkComparison,
} from "../controllers/admin.js";
import { requireApiKey } from "../middleware/auth.js";
import { ipAllowlist } from "../middleware/ipAllowlist.js";

export const adminRouter = Router();

adminRouter.use(ipAllowlist());
adminRouter.use(requireApiKey({ minRole: "readonly" }));

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/indexer", getAdminIndexer);
adminRouter.get("/indexer/stream", streamIndexerProgress);
adminRouter.post("/indexer/backfill", requireApiKey({ role: "admin" }), backfillIndexer);
adminRouter.get("/events", getAdminEvents);
adminRouter.get("/vaults/:contractId/audit", getVaultAudit);
adminRouter.get("/vaults/archived", getArchivedVaults);
adminRouter.get("/consistency/total-supply", getTotalSupplyConsistency);
adminRouter.get("/api-keys", getApiKeys);
adminRouter.delete("/api-keys/:id", requireApiKey({ role: "admin" }), deleteApiKey);
adminRouter.get("/webhooks/:id/deliveries", getWebhookDeliveries);
// Issue #1006: bulk webhook enable/disable
adminRouter.post("/webhooks/bulk/toggle", requireApiKey({ role: "admin" }), bulkToggleWebhooks);
adminRouter.get("/db/stats", getDbStats);
adminRouter.get("/fees", getAdminFees);
adminRouter.get("/fees/dashboard", requireApiKey({ role: "admin" }), getAdminFeesDashboard);
adminRouter.delete("/users/:address", requireApiKey({ role: "admin" }), deleteUser);
adminRouter.get("/audit-log", requireApiKey({ role: "admin" }), getAdminAuditLog);

adminRouter.post("/users/:address/aml-flag", flagUserAml);
adminRouter.post("/users/:address/aml-clear", clearUserAml);
adminRouter.get("/compliance/flagged-users", getFlaggedUsers);
adminRouter.get("/compliance/positions-snapshot", getPositionsSnapshot);

// Issue #803: Vault compliance status
adminRouter.get("/compliance/vaults/:contractId/status", getVaultComplianceStatus);
// Issue #802: User compliance summary
adminRouter.get("/compliance/users/:address/summary", getUserComplianceSummary);

// Issue #804: Data retention policy
adminRouter.get("/retention-policy", getRetentionPolicy);
adminRouter.patch("/retention-policy", patchRetentionPolicy);

adminRouter.get("/jobs/dashboard", getJobQueueDashboard);
adminRouter.get("/jobs/failed", getFailedJobs);
adminRouter.get("/jobs/:jobId", getJobStatus);

// Issue #966: index usage statistics
adminRouter.get("/db/index-stats", getIndexStats);
// Issue #967: connection pool statistics
adminRouter.get("/db/pool-stats", getPoolStats);
// Issue #965: benchmark comparison report
adminRouter.get("/benchmarks/compare", getBenchmarkComparison);

