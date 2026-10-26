import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  rpcMonitorCallsTotal,
  rpcMonitorCallDurationSeconds,
  rpcActiveRequests,
} from "./metrics.js";

// ── RPC error-rate alerting (#829) ────────────────────────────────────────────
//
// Tracks RPC success and error counts in a rolling 5-minute window held in
// memory. At the end of each window the rate is evaluated: if errors / total
// exceeds RPC_ERROR_RATE_ALERT_PCT (default 10 %), an error-level log is
// emitted. Counters reset at the start of every new window.

let windowErrors = 0;
let windowSuccesses = 0;

export function recordRpcSuccess(method?: string): void {
  windowSuccesses++;
  if (method) {
    rpcMonitorCallsTotal.inc({ method, status: "success" });
  }
}

export function recordRpcError(method?: string): void {
  windowErrors++;
  if (method) {
    rpcMonitorCallsTotal.inc({ method, status: "error" });
  }
}

/**
 * Record the start of an RPC call, returning a function to call when complete.
 * Tracks duration and active request count.
 */
export function startRpcCall(method: string): () => void {
  const start = Date.now();
  rpcActiveRequests.inc();

  return () => {
    const durationSeconds = (Date.now() - start) / 1000;
    rpcMonitorCallDurationSeconds.observe({ method }, durationSeconds);
    rpcActiveRequests.dec();
  };
}

function flushWindow(): void {
  const total = windowErrors + windowSuccesses;
  if (total === 0) {
    windowErrors = 0;
    windowSuccesses = 0;
    return;
  }

  const ratePct = Math.round((windowErrors / total) * 100);
  if (ratePct > config.rpcErrorRateAlertPct) {
    logger.error(
      { windowErrors, windowSuccesses, total, ratePct },
      `RPC error rate ${ratePct}% exceeds threshold`,
    );
  }

  windowErrors = 0;
  windowSuccesses = 0;
}

// Only start the interval outside of tests so unit tests aren't burdened with
// timer teardown. The interval is unref'd so it never prevents process exit.
if (process.env["NODE_ENV"] !== "test") {
  setInterval(flushWindow, 5 * 60 * 1000).unref();
}
