import client from "prom-client";

const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// Error-rate companion to http_requests_total (#831). Kept as a separate
// counter so error ratios can be charted without a full label-set join in
// PromQL. `statusClass` collapses 400-499 into "4xx" and 500-599 into "5xx" to
// bound cardinality; everything else is ignored.
export const httpErrorsTotal = new client.Counter({
  name: "http_errors_total",
  help: "Total number of HTTP error responses (4xx and 5xx) by status class",
  labelNames: ["statusClass", "route"] as const,
  registers: [register],
});

// 5xx-only companion to http_errors_total (#1091). Alerting on elevated 5xx
// rates is a single PromQL expression against this counter, without having to
// filter http_errors_total by statusClass. `method` and `route` are the only
// labels, bounding cardinality to the number of registered routes.
export const http5xxTotal = new client.Counter({
  name: "http_5xx_total",
  help: "Total number of HTTP responses with a 5xx status, by method and route",
  labelNames: ["method", "route"] as const,
  registers: [register],
});

// Number of SSE connections currently held open (#1092). Each stream pins a
// socket and a file descriptor plus the response buffer, so a rising gauge is
// the early signal that a deploy is running into memory or fd limits.
export const sseActiveConnections = new client.Gauge({
  name: "sse_active_connections",
  help: "Number of currently open Server-Sent Events connections",
  registers: [register],
});

// pg-boss queue depth (#1093). Gauges rather than counters because a job moving
// from `created` to `active` to `failed` does not accumulate: the interesting
// signal is the current number of jobs sitting in each state, sampled by
// JobQueueDepthPoller (services/jobQueueDepthPoller.ts).
export const pgbossJobsCreated = new client.Gauge({
  name: "pgboss_jobs_created",
  help: "Number of pg-boss jobs currently in the 'created' state",
  registers: [register],
});

export const pgbossJobsActive = new client.Gauge({
  name: "pgboss_jobs_active",
  help: "Number of pg-boss jobs currently in the 'active' state",
  registers: [register],
});

export const pgbossJobsFailed = new client.Gauge({
  name: "pgboss_jobs_failed",
  help: "Number of pg-boss jobs currently in the 'failed' state",
  registers: [register],
});

// Prime the gauges so they are exposed by /metrics with a value of 0 from the
// first scrape, before any SSE stream is opened or the queue poller completes
// its first pass. Alerting rules like `pgboss_jobs_failed > 0` must not depend
// on warm-up ordering.
sseActiveConnections.set(0);
pgbossJobsCreated.set(0);
pgbossJobsActive.set(0);
pgbossJobsFailed.set(0);

// Backing count for sse_active_connections. Kept in module scope because the
// prom-client Gauge API only exposes its value asynchronously, and the decrement
// path needs the current count synchronously in order to clamp it at zero.
let sseConnections = 0;

export const indexerEventsProcessedTotal = new client.Counter({
  name: "indexer_events_processed_total",
  help: "Total number of on-chain events indexed (incremented once per event)",
  registers: [register],
});

// Per-batch processing time (#1109): one observation per polling tick or
// backfill batch, covering the event fetch and processing of every event in it.
export const indexerProcessingDurationSeconds = new client.Histogram({
  name: "indexer_processing_duration_seconds",
  help: "Indexer per-batch processing duration in seconds",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const indexerLastLedger = new client.Gauge({
  name: "indexer_last_ledger",
  help: "Last indexed ledger sequence number",
  registers: [register],
});

export const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "Database query duration in seconds",
  labelNames: ["query"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const jobQueuePendingTotal = new client.Gauge({
  name: "job_queue_pending_total",
  help: "Total number of pending jobs in queue",
  labelNames: ["job_name"] as const,
  registers: [register],
});

export const jobQueueFailedTotal = new client.Counter({
  name: "job_queue_failed_total",
  help: "Total number of failed jobs in queue",
  labelNames: ["job_name"] as const,
  registers: [register],
});

export const jobDurationSeconds = new client.Histogram({
  name: "job_duration_seconds",
  help: "Job execution duration in seconds",
  labelNames: ["job_name"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

export async function updateJobQueuePendingMetrics(): Promise<void> {
  try {
    const { query } = await import("../db/index.js");
    const rows = await query<{ name: string; count: string }>(
      `SELECT name, COUNT(*)::text AS count
       FROM pgboss.job
       WHERE state IN ('created', 'retry')
       GROUP BY name`,
    );
    jobQueuePendingTotal.reset();
    for (const row of rows) {
      jobQueuePendingTotal.set({ job_name: row.name }, parseInt(row.count, 10));
    }
  } catch {
    // Ignore errors when database is unavailable in test environments
  }
}

export async function getMetrics(): Promise<string> {
  await updateJobQueuePendingMetrics();
  return register.metrics();
}

/**
 * Record a finished HTTP response on the 5xx counter (#1091).
 *
 * A status of 500 or above increments `http_5xx_total`. Any other status for a
 * route Express actually matched initialises the series at 0, so a healthy
 * route is reported as 0 instead of being absent from the scrape. Unmatched
 * paths (404s and anything else that falls through to `notFoundHandler`) are
 * skipped: their raw path would create an unbounded number of series.
 *
 * Never throws: a metrics failure must not be able to fail the response.
 */
export function recordHttp5xx(
  method: string | undefined,
  route: string | undefined,
  statusCode: number,
  matched = true,
): void {
  if (!Number.isFinite(statusCode)) return;

  const labels = { method: method || "unknown", route: route || "unknown" };
  try {
    if (statusCode >= 500) {
      http5xxTotal.inc(labels);
    } else if (matched) {
      http5xxTotal.inc(labels, 0);
    }
  } catch {
    // Ignore: never let a metrics failure affect the response
  }
}

/**
 * Increment `sse_active_connections` when a stream is opened (#1092).
 */
export function incrementSseConnections(): void {
  try {
    sseConnections += 1;
    sseActiveConnections.set(sseConnections);
  } catch {
    // Ignore: never let a metrics failure break the connection handshake
  }
}

/**
 * Decrement `sse_active_connections` when a stream closes (#1092).
 *
 * Clamped at 0: a `close` event can fire more than once for the same connection
 * (request and response both emit one), and a negative connection count would
 * be nonsense to alert on.
 */
export function decrementSseConnections(): void {
  try {
    sseConnections = Math.max(0, sseConnections - 1);
    sseActiveConnections.set(sseConnections);
  } catch {
    // Ignore: never let a metrics failure break connection teardown
  }
}

/**
 * Reset `sse_active_connections` to 0. Used when in-process connection state is
 * dropped wholesale (tests, and any future forced-disconnect sweep) so the
 * gauge cannot drift away from the number of streams actually held.
 */
export function resetSseConnections(): void {
  sseConnections = 0;
  sseActiveConnections.set(0);
}

export interface JobQueueDepth {
  created: number;
  active: number;
  failed: number;
}

/**
 * Publish a pg-boss queue depth sample (#1093). All three states are set on
 * every sample so a queue that drains back to empty reports 0 again rather than
 * keeping the last non-zero value.
 */
export function setJobQueueDepth(depth: JobQueueDepth): void {
  pgbossJobsCreated.set(depth.created);
  pgbossJobsActive.set(depth.active);
  pgbossJobsFailed.set(depth.failed);
}

/**
 * Map an HTTP status onto the coarse class used as the `statusClass` label.
 * Returns null for anything that is not a 4xx/5xx so success responses never
 * reach the error counter.
 */
export function httpStatusClass(statusCode: number): "4xx" | "5xx" | null {
  if (!Number.isFinite(statusCode)) return null;
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return null;
}

/**
 * Increment http_errors_total for a single error response (#831).
 *
 * `route` is the matched route pattern when Express resolved one, otherwise
 * the request path. Never throws: metrics must not be able to turn a handled
 * error into a failed response.
 */
export function recordHttpError(route: string | undefined, statusCode: number): void {
  const statusClass = httpStatusClass(statusCode);
  if (statusClass === null) return;

  try {
    httpErrorsTotal.inc({ statusClass, route: route || "unknown" });
  } catch {
    // Ignore: never let a metrics failure affect the response
  }
}


