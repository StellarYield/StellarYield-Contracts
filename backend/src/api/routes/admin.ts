import { Router } from "express";
import {
  getAdminStats,
  getAdminIndexer,
  getAdminEvents,
  getVaultAudit,
  backfillIndexer,
  deleteApiKey,
  getApiKeys,
  updateApiKeyDescription,
  getWebhookDeliveries,
  bulkToggleWebhooks,
  getArchivedVaults,
  getTotalSupplyConsistency,
  getDbStats,
  getSlowQueries,
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
  exportPositionsCsv,
  streamIndexerProgress,
  getVaultComplianceStatus,
  getUserComplianceSummary,
  getRetentionPolicy,
  patchRetentionPolicy,
  postBenchmark,
  getBenchmarksByName,
  vacuumDatabase,
  createAdminSession,
  refreshAdminSession,
  getSecurityHeadersAudit,
  resetSandboxData,
  getSecurityEvents,
  toggleVaultArchiveExclusion,
  verifyArchiveConsistency,
} from "../controllers/admin.js";
import { requireApiKey } from "../middleware/auth.js";
import { ipAllowlist } from "../middleware/ipAllowlist.js";
import { config } from "../../config.js";
import { jobQueue } from "../../services/jobQueue.js";

export const adminRouter = Router();

adminRouter.post("/session", createAdminSession);
adminRouter.post("/session/refresh", refreshAdminSession);
adminRouter.use(ipAllowlist());
adminRouter.use(requireApiKey({ minRole: "readonly" }));

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/indexer", getAdminIndexer);
adminRouter.get("/indexer/stream", streamIndexerProgress);
adminRouter.post("/vaults/reindex", requireApiKey({ role: "admin" }), async (req, res) => {
  if (config.sandboxMode) {
    res.set("X-Sandbox", "true");
    res.json({ success: true });
    return;
  }

  await jobQueue.send("vaults-reindex", { triggeredBy: req.apiKey?.label ?? "admin" });
  res.json({ success: true });
});
adminRouter.post("/indexer/backfill", requireApiKey({ role: "admin" }), backfillIndexer);
adminRouter.get("/events", getAdminEvents);
adminRouter.get("/vaults/:contractId/audit", getVaultAudit);
adminRouter.get("/vaults/archived", getArchivedVaults);
adminRouter.patch("/vaults/:contractId/archive-exclusion", requireApiKey({ role: "admin" }), toggleVaultArchiveExclusion);
adminRouter.get("/archive/verify", verifyArchiveConsistency);
adminRouter.get("/consistency/total-supply", getTotalSupplyConsistency);
adminRouter.get("/api-keys", getApiKeys);
adminRouter.delete("/api-keys/:id", requireApiKey({ role: "admin" }), deleteApiKey);
adminRouter.patch("/api-keys/:id/description", requireApiKey({ role: "admin" }), updateApiKeyDescription);
adminRouter.get("/api-diff", getApiDiff);
adminRouter.get("/webhooks/:id/deliveries", getWebhookDeliveries);
// Issue #1006: bulk webhook enable/disable
adminRouter.post("/webhooks/bulk/toggle", requireApiKey({ role: "admin" }), bulkToggleWebhooks);
adminRouter.get("/db/stats", getDbStats);
adminRouter.get("/db/slow-queries", getSlowQueries);
adminRouter.get("/fees", getAdminFees);
adminRouter.get("/fees/dashboard", requireApiKey({ role: "admin" }), getAdminFeesDashboard);
adminRouter.delete("/users/:address", requireApiKey({ role: "admin" }), deleteUser);
adminRouter.get("/audit-log", requireApiKey({ role: "admin" }), getAdminAuditLog);

adminRouter.post("/users/:address/aml-flag", flagUserAml);
adminRouter.post("/users/:address/aml-clear", clearUserAml);
adminRouter.get("/compliance/flagged-users", getFlaggedUsers);
adminRouter.get("/compliance/positions-snapshot", getPositionsSnapshot);
// Issue #950: streamed CSV export of all user vault positions
adminRouter.get("/positions/export.csv", exportPositionsCsv);

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

adminRouter.post("/benchmarks", requireApiKey({ role: "admin" }), postBenchmark);
adminRouter.get("/benchmarks/:name", getBenchmarksByName);
adminRouter.get("/security/headers-audit", requireApiKey({ role: "admin" }), getSecurityHeadersAudit);
adminRouter.get("/security/events", requireApiKey({ role: "admin" }), getSecurityEvents);
adminRouter.post("/sandbox/reset", requireApiKey({ role: "admin" }), resetSandboxData);

adminRouter.post("/db/vacuum", requireApiKey({ role: "admin" }), vacuumDatabase);

