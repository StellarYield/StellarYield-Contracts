import { Router } from "express";
import {
  getAdminStats,
  getAdminIndexer,
  getIndexerDeadLetters,
  getIndexerEventCounts,
  getQuarterlyYieldReport,
  getTransferAlerts,
  acknowledgeTransferAlert,
  getIndexerStartBlock,
  updateIndexerStartBlock,
  getAdminEvents,
  getVaultAudit,
  getEpochAnomalies,
  backfillIndexer,
  pauseContractIndexing,
  resumeContractIndexing,
  setContractEventFilter,
  deleteApiKey,
  getApiKeys,
  updateApiKeyDescription,
  getWebhookDeliveries,
  bulkToggleWebhooks,
  resetWebhookCircuit,
  rotateWebhookSecret,
  replayWebhookDelivery,
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
  getApiDiff,
  getApiKeyUsageStats,
  exportVaultsCsv,
  exportAdminAuditLogCsv,
  getVaultNotes,
  createVaultNote,
  getVaultTags,
  updateVaultTags,
} from "../controllers/admin.js";
import { getRequestArchive } from "../controllers/debugArchive.js";
import { createAnnouncement, deleteAnnouncement } from "../controllers/announcements.js";
import { postArchiveRestore, getArchiveStatusHandler } from "../controllers/archiveAdmin.js";
import { getHolderConcentrationReport } from "../controllers/regulatoryReports.js";
import { requireApiKey } from "../middleware/auth.js";
import { adminFeesRouter } from "./fees.js";
import { ipAllowlist } from "../middleware/ipAllowlist.js";
import { normalizeAddressParam } from "../middleware/normalizeAddressParams.js";
import { config } from "../../config.js";
import { jobQueue } from "../../services/jobQueue.js";

export const adminRouter = Router();
adminRouter.param("address", normalizeAddressParam("address"));
adminRouter.param("contractId", normalizeAddressParam("contractId"));

adminRouter.post("/session", createAdminSession);
adminRouter.post("/session/refresh", refreshAdminSession);
adminRouter.use(ipAllowlist());
adminRouter.use(requireApiKey({ minRole: "readonly" }));

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/reports/vaults.csv", exportVaultsCsv);
adminRouter.get("/indexer", getAdminIndexer);
adminRouter.get("/indexer/dead-letters", getIndexerDeadLetters);
// Issue #1108: event counts per contract
adminRouter.get("/indexer/event-counts", getIndexerEventCounts);
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
// Per-contract indexer controls (#1106, #1107)
adminRouter.post("/indexer/:contractId/pause", requireApiKey({ role: "admin" }), pauseContractIndexing);
adminRouter.post("/indexer/:contractId/resume", requireApiKey({ role: "admin" }), resumeContractIndexing);
adminRouter.patch("/indexer/:contractId/event-filter", requireApiKey({ role: "admin" }), setContractEventFilter);
// Issue #1105: indexer start-block configuration (readable by readonly keys,
// writable by admins only)
adminRouter.get("/indexer/start-block", getIndexerStartBlock);
adminRouter.put("/indexer/start-block", requireApiKey({ role: "admin" }), updateIndexerStartBlock);
adminRouter.get("/events", getAdminEvents);
adminRouter.get("/vaults/:contractId/audit", getVaultAudit);
// Epoch yield outliers detected by the daily scan (#1073). Read-only, so the
// router-wide readonly requirement is enough.
adminRouter.get("/vaults/:contractId/epoch-anomalies", getEpochAnomalies);
// Internal admin notes (#1281)
adminRouter.get("/vaults/:contractId/notes", getVaultNotes);
adminRouter.post("/vaults/:contractId/notes", requireApiKey({ role: "admin" }), createVaultNote);
// Internal admin tags (#1282)
adminRouter.get("/vaults/:contractId/tags", getVaultTags);
adminRouter.put("/vaults/:contractId/tags", requireApiKey({ role: "admin" }), updateVaultTags);
adminRouter.get("/vaults/archived", getArchivedVaults);
adminRouter.patch("/vaults/:contractId/archive-exclusion", requireApiKey({ role: "admin" }), toggleVaultArchiveExclusion);
adminRouter.get("/archive/verify", verifyArchiveConsistency);
adminRouter.get("/debug/archive", requireApiKey({ role: "admin" }), getRequestArchive);
adminRouter.get("/consistency/total-supply", getTotalSupplyConsistency);
adminRouter.get("/api-keys", getApiKeys);
adminRouter.get("/api-keys/:id/usage", requireApiKey({ role: "admin" }), getApiKeyUsageStats);
adminRouter.delete("/api-keys/:id", requireApiKey({ role: "admin" }), deleteApiKey);
adminRouter.patch("/api-keys/:id/description", requireApiKey({ role: "admin" }), updateApiKeyDescription);
adminRouter.get("/api-diff", getApiDiff);
// Issue #1006: bulk webhook enable/disable
adminRouter.post("/webhooks/bulk/toggle", requireApiKey({ role: "admin" }), bulkToggleWebhooks);
// Issues #1061/#1062/#1063: circuit breaker reset, secret rotation, delivery replay.
// Registered before /webhooks/:id/deliveries so the literal `deliveries` segment
// is not swallowed by the `:id` param.
adminRouter.post("/webhooks/deliveries/:deliveryId/replay", requireApiKey({ role: "admin" }), replayWebhookDelivery);
adminRouter.get("/webhooks/:id/deliveries", getWebhookDeliveries);
adminRouter.post("/webhooks/:id/circuit-reset", requireApiKey({ role: "admin" }), resetWebhookCircuit);
adminRouter.post("/webhooks/:id/rotate-secret", requireApiKey({ role: "admin" }), rotateWebhookSecret);
adminRouter.get("/db/stats", getDbStats);
adminRouter.get("/db/slow-queries", getSlowQueries);
adminRouter.get("/fees", getAdminFees);
adminRouter.get("/fees/dashboard", requireApiKey({ role: "admin" }), getAdminFeesDashboard);
adminRouter.delete("/users/:address", requireApiKey({ role: "admin" }), deleteUser);
adminRouter.get("/audit-log/export.csv", requireApiKey({ role: "admin" }), exportAdminAuditLogCsv);
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

// Issue #1114: quarterly yield report
adminRouter.get("/reports/quarterly", getQuarterlyYieldReport);

// Issue #1112: regulatory report — vault holder concentration
adminRouter.get("/regulatory/holder-concentration", getHolderConcentrationReport);

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
// #921: Archive restore
adminRouter.post("/archive/restore", requireApiKey({ role: "admin" }), postArchiveRestore);
// #922: Archive status
adminRouter.get("/archive/status", requireApiKey({ minRole: "readonly" }), getArchiveStatusHandler);
// #921 — Archive restore
adminRouter.post("/archive/restore", requireApiKey({ role: "admin" }), postArchiveRestore);
// #922 — Archive status
adminRouter.get("/archive/status", requireApiKey({ minRole: "readonly" }), getArchiveStatusHandler);

// Fee tiers and fee rebates (#1099, #1103)
adminRouter.use("/vaults", adminFeesRouter);

// Issues #1077, #1078: Transfer alerts
adminRouter.get("/transfer-alerts", getTransferAlerts);
adminRouter.patch("/transfer-alerts/:id/acknowledge", acknowledgeTransferAlert);

// Issue #1287: operator announcements (publish / remove)
adminRouter.post("/announcements", requireApiKey({ role: "admin" }), createAnnouncement);
adminRouter.delete("/announcements/:id", requireApiKey({ role: "admin" }), deleteAnnouncement);


