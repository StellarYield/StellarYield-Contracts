import pino from "pino";
import crypto from "node:crypto";
import { config } from "./config.js";

const SENSITIVE_FIELDS = new Set(["key", "secret", "password", "authorization", "token"]);

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv !== "production"
      ? { target: "pino-pretty" }
      : undefined,
  redact: {
    paths: Array.from(SENSITIVE_FIELDS).map((f) => `*.${f}`),
    remove: true,
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
  },
});

// Reduce an RPC endpoint URL to its origin before it is logged (#1206). API
// tokens are commonly carried in the path, the query or the userinfo, so only
// the scheme, host and port are kept.
export function redactRpcUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "[REDACTED]";
  }
}

export function maskSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...obj };
  for (const key of Object.keys(masked)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      masked[key] = "[REDACTED]";
    }
  }
  return masked;
}

// ── Error log deduplication (#1257) ───────────────────────────────────────────
// A failing dependency can flood logs with identical errors. We fingerprint
// each error (hash of name + top stack frame) and only log the full details
// for the first occurrence. Subsequent identical errors are counted and
// summarised every 60 seconds so operators still see the problem but the log
// stays readable.
interface FingerprintState {
  count: number;
  firstSeen: number;
  summaryTimer: ReturnType<typeof setInterval> | undefined;
}

const fingerprintCache = new Map<string, FingerprintState>();
const SUMMARY_INTERVAL_MS = 60_000;

/**
 * Compute a stable fingerprint for an error: hash of the error name plus the
 * top stack frame (file + line), so two errors with the same message but from
 * different call sites are treated as distinct.
 */
function computeFingerprint(err: Error): string {
  const stackLine = err.stack?.split("\n")[1]?.trim() ?? "";
  return crypto
    .createHash("sha256")
    .update(`${err.name}:${stackLine}`)
    .digest("hex")
    .slice(0, 16);
}

function startSummaryTimer(fp: string): void {
  const state = fingerprintCache.get(fp);
  if (!state || state.summaryTimer) return;
  state.summaryTimer = setInterval(() => {
    if (state.count > 0) {
      logger.warn(
        { fingerprint: fp, suppressedCount: state.count, windowSeconds: SUMMARY_INTERVAL_MS / 1000 },
        "suppressed duplicate errors",
      );
      state.count = 0;
    }
  }, SUMMARY_INTERVAL_MS);
  state.summaryTimer.unref();
}

/**
 * Log an error with deduplication. The first occurrence is logged in full
 * (level: error). Identical subsequent errors are counted and summarised at
 * a 60-second interval.
 *
 * Usage:  dedupeError(new Error("..."), { context: "indexer" });
 */
export function dedupeError(err: Error, extra?: Record<string, unknown>): void {
  const fp = computeFingerprint(err);
  let state = fingerprintCache.get(fp);
  if (!state) {
    state = { count: 0, firstSeen: Date.now(), summaryTimer: undefined };
    fingerprintCache.set(fp, state);
    // First occurrence — log in full.
    logger.error({ err, ...extra, fingerprint: fp }, err.message);
    startSummaryTimer(fp);
    return;
  }
  state.count += 1;
}
