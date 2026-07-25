import "dotenv/config";
import { query, pool } from "../db/index.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

interface IndexerState {
  last_ledger: number;
}

interface ChainLedger {
  sequence: number;
}

async function checkIndexer(): Promise<void> {
  try {
    logger.info("Checking indexer state consistency");

    // Get last ledger from indexer_state
    const stateRows = await query<IndexerState>(
      "SELECT last_ledger FROM indexer_state ORDER BY updated_at DESC LIMIT 1"
    );

    if (stateRows.length === 0) {
      logger.error("No indexer state found in database");
      process.exit(1);
    }

    const lastLedger = stateRows[0].last_ledger;
    logger.info({ lastLedger }, "Retrieved last_ledger from indexer_state");

    // Get current chain ledger from RPC
    let chainLedger = 0;
    try {
      const rpcUrl = config.stellar.rpcUrl;
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLatestLedger",
          params: {},
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC request failed with status ${response.status}`);
      }

      const rpcData = (await response.json()) as { result?: ChainLedger };
      if (rpcData.result?.sequence) {
        chainLedger = rpcData.result.sequence;
      } else {
        throw new Error("Invalid RPC response format");
      }

      logger.info({ chainLedger }, "Retrieved current ledger from chain");
    } catch (err) {
      logger.error(err, "Failed to fetch current ledger from RPC");
      process.exit(1);
    }

    // Calculate lag
    const lag = chainLedger - lastLedger;
    const healthyLagThreshold = 500;

    logger.info(
      { lastLedger, chainLedger, lag, threshold: healthyLagThreshold },
      "Indexer state check result"
    );

    if (lag > healthyLagThreshold) {
      logger.error(
        {
          lastLedger,
          chainLedger,
          lag,
          threshold: healthyLagThreshold,
          alert: `Indexer is ${lag} ledgers behind (threshold: ${healthyLagThreshold})`,
        },
        "ALERT: Indexer lag exceeds threshold"
      );
      await pool.end();
      process.exit(1);
    }

    logger.info("Indexer is healthy");
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error(err, "Indexer check failed");
    process.exit(1);
  }
}

await checkIndexer();
