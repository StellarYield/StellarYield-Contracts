import "./instrumentation.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { warmUpPool, closePool } from "./db/index.js";
import { closeRedis } from "./cache/redis.js";
import { shutdown as runShutdown, type ShutdownDeps } from "./shutdown.js";
import { indexer } from "./services/indexerSingleton.js";
import { jobQueue } from "./services/jobQueue.js";
import { EventsPruner } from "./services/eventsPruner.js";
import { JobQueueDepthPoller } from "./services/jobQueueDepthPoller.js";
import { runDeploymentBenchmarksIfNeeded } from "./services/queryBenchmarks.js";
import { registerProcessErrorHandlers } from "./services/processErrors.js";
import { startRpcHealthProbes, stopRpcHealthProbes } from "./services/rpcHealth.js";

// Registered before any startup work, so a rejection in warmUpPool or the listen callback is logged at fatal level (#1249).
registerProcessErrorHandlers();

const app = createApp();
const pruner = new EventsPruner();
// pg-boss queue depth gauges for /metrics (#1093)
const jobQueueDepthPoller = new JobQueueDepthPoller();

// Establish the configured number of pool connections before we start accepting
// traffic, so cold-start requests don't time out waiting on connection setup
// under load (#951).
await warmUpPool();

// Network passphrase validation (#1197): confirm the RPC server is on the
// expected network before starting the indexer. Exits with code 1 on mismatch
// to prevent indexing events from the wrong network.
await validateNetworkPassphrase();

const server = app.listen(config.port, async () => {
  logger.info(
    { port: config.port, env: config.nodeEnv, network: config.stellar.network },
    `StellarYield backend started — Connected to Stellar ${config.stellar.network}`,
  );
  try {
    await jobQueue.start();
  } catch (err) {
    logger.error({ err }, "Failed to start job queue; continuing without it");
  }
  // Issue #964: benchmark hot queries once per deployment
  void runDeploymentBenchmarksIfNeeded();
  void indexer.start();
  pruner.start();
  jobQueueDepthPoller.start();
  startRpcHealthProbes();
});

/**
 * Ordered teardown (#1294): stop accepting requests, then drain the indexer and
 * job queue before closing Redis and the database pool. Runs through
 * `runShutdown` so the sequence is a single, testable source of truth.
 */
const shutdownDeps: ShutdownDeps = {
  stopListening: () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  drainIndexer: async () => {
    // Auxiliary pollers stop alongside the indexer; neither should keep writing
    // while the indexer drains.
    pruner.stop();
    jobQueueDepthPoller.stop();
    await indexer.drain();
  },
  flushJobs: () => jobQueue.stop(),
  closeRedis: () => closeRedis(),
  closePool: () => closePool(),
};

let shuttingDown = false;
async function handleSignal(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, `Received ${signal}, shutting down`);
  await runShutdown(shutdownDeps);
}

process.on("SIGTERM", () => void handleSignal("SIGTERM"));
process.on("SIGINT", () => void handleSignal("SIGINT"));
