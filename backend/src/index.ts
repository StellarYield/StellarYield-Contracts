import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { indexer } from "./services/indexerSingleton.js";
import { EventsPruner } from "./services/eventsPruner.js";

const app = createApp();
const pruner = new EventsPruner();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, "StellarYield backend started");
  void indexer.start();
  pruner.start();
});

function shutdown(): void {
  logger.info("Shutting down");
  indexer.stop();
  pruner.stop();
  server.close(() => {
    logger.info("StellarYield backend stopped");
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
