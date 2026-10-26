/**
 * Network passphrase validation at startup.
 *
 * Validates that the RPC server's network passphrase matches the configured
 * STELLAR_NETWORK environment variable. Exits with code 1 on mismatch to
 * prevent indexing events from the wrong network.
 *
 * Closes #1197
 */

import { config } from "../config.js";
import { logger } from "../logger.js";
import { getSorobanRpc } from "./stellar.js";
import { validateRpcResponse, getNetworkSchema } from "./rpcSchemas.js";

/**
 * Validate that the RPC server's network passphrase matches the configured
 * network. Logs a confirmation on match, or logs an error and exits with
 * code 1 on mismatch.
 *
 * This check must run after the RPC client is available but before the indexer
 * starts processing events, so no events from the wrong network are indexed.
 */
export async function validateNetworkPassphrase(): Promise<void> {
  const server = getSorobanRpc();
  const expectedPassphrase = config.stellar.networkPassphrase;
  const configuredNetwork = config.stellar.network;

  try {
    const rawNetworkInfo = await server.getNetwork();
    const networkInfo = validateRpcResponse("getNetwork", rawNetworkInfo, getNetworkSchema);
    const actualPassphrase = networkInfo.passphrase;

    if (actualPassphrase === expectedPassphrase) {
      logger.info(
        { network: configuredNetwork, passphrase: actualPassphrase },
        `Network passphrase validated: ${configuredNetwork}`,
      );
      return;
    }

    // Mismatch detected — log descriptive error and exit
    logger.error(
      {
        configuredNetwork,
        expectedPassphrase,
        actualPassphrase,
      },
      "Network passphrase mismatch — aborting startup. " +
      `Configured STELLAR_NETWORK=${configuredNetwork} expects passphrase "${expectedPassphrase}", ` +
      `but RPC returned "${actualPassphrase}". ` +
      "Update STELLAR_NETWORK or STELLAR_RPC_URL to match the target network.",
    );
    process.exit(1);
  } catch (err) {
    logger.error(
      { err, configuredNetwork, rpcUrl: config.stellar.rpcUrl },
      "Failed to fetch network info from RPC during passphrase validation — aborting startup",
    );
    process.exit(1);
  }
}
