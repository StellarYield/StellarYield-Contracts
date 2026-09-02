import "./instrumentation.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { warmUpPool } from "./db/index.js";
import { indexer } from "./services/indexerSingleton.js";
import { jobQueue } from "./services/jobQueue.js";
import { EventsPruner } from "./services/eventsPruner.js";

const app = createApp();
const pruner = new EventsPruner();

// Establish the configured number of pool connections before we start accepting
// traffic, so cold-start requests don't time out waiting on connection setup
// under load (#951).
await warmUpPool();

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
  void indexer.start();
  pruner.start();
});

async function shutdown(): Promise<void> {
  logger.info("Shutting down");
  indexer.stop();
  pruner.stop();
  await jobQueue.stop();
  server.close(() => {
    logger.info("StellarYield backend stopped");
  });
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
