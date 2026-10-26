import { logger } from "./logger.js";

/**
 * The order in which the process releases its resources on shutdown (#1294).
 *
 * Each step depends on the ones before it:
 *   1. `stopListening` — stop accepting new requests first, so no new work is
 *      admitted while the remaining resources are being wound down.
 *   2. `drainIndexer`  — let the indexer finish its in-flight tick/backfill,
 *      because it writes through the database pool.
 *   3. `flushJobs`     — stop the background job queue, which also writes to the
 *      database.
 *   4. `closeRedis`    — close the cache client.
 *   5. `closePool`     — close the database pool last, once nothing can use it.
 */
export const SHUTDOWN_ORDER = [
  "stopListening",
  "drainIndexer",
  "flushJobs",
  "closeRedis",
  "closePool",
] as const;

export type ShutdownStep = (typeof SHUTDOWN_ORDER)[number];

export interface ShutdownDeps {
  /** Stop accepting new connections/requests. */
  stopListening(): void | Promise<void>;
  /** Let the indexer finish its in-flight work and stop polling. */
  drainIndexer(): void | Promise<void>;
  /** Flush and stop the background job queue. */
  flushJobs(): void | Promise<void>;
  /** Close the Redis client. */
  closeRedis(): void | Promise<void>;
  /** End the Postgres pool(s). */
  closePool(): void | Promise<void>;
  /** Optional observer, invoked after each step completes (used by tests/logging). */
  onStep?: (step: ShutdownStep) => void;
}

/**
 * Run every shutdown step in {@link SHUTDOWN_ORDER}, sequentially.
 *
 * Steps run one at a time and each is awaited, so a slow drain cannot be
 * overtaken by the pool closing underneath it. A step that throws is logged and
 * skipped rather than aborting the sequence: releasing the remaining resources
 * still matters, otherwise a single failure would hang the process on exit.
 *
 * Returns the steps that completed, in execution order, so callers (and tests)
 * can assert the actual ordering.
 */
export async function shutdown(deps: ShutdownDeps): Promise<ShutdownStep[]> {
  const completed: ShutdownStep[] = [];
  logger.info("Shutting down");

  for (const step of SHUTDOWN_ORDER) {
    try {
      await deps[step]();
      completed.push(step);
      deps.onStep?.(step);
    } catch (err) {
      logger.error({ err, step }, `shutdown step "${step}" failed`);
    }
  }

  logger.info({ completed }, "Shutdown complete");
  return completed;
}
