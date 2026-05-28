import { Account, Contract, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { rpc, scValToNative, xdr, Address } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import type { VaultState } from "../types/index.js";

export function getSorobanRpc(): rpc.Server {
  return new rpc.Server(config.stellar.rpcUrl);
}

/**
 * Simulate a read-only contract call and return the decoded native value.
 * Uses a zero-sequence throwaway account — no signing required for simulations.
 */
async function simulateRead<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const server = getSorobanRpc();

  // Throwaway source account — sequence number 0 is fine for simulation only.
  const source = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );

  const op = new Contract(contractId).call(method, ...args);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error for ${method}: ${sim.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Unexpected simulation response for ${method}`);
  }

  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (retval === undefined || retval === null) {
    throw new Error(`No return value from ${method}`);
  }

  return scValToNative(retval) as T;
}

/**
 * Read the current vault state from the contract.
 * Returns one of: "Funding" | "Active" | "Matured" | "Closed" | "Cancelled"
 *
 * Closes #425
 */
export async function readVaultState(contractId: string): Promise<VaultState> {
  // vault_state() returns a Soroban enum — scValToNative decodes it to its
  // string variant name (e.g. "Funding", "Active", …).
  const raw = await simulateRead<Record<string, unknown> | string>(
    contractId,
    "vault_state",
  );

  // scValToNative may return the enum as { Funding: void } or plain "Funding"
  // depending on SDK version — normalise both forms.
  if (typeof raw === "string") {
    return raw as VaultState;
  }
  const variant = Object.keys(raw)[0];
  return variant as VaultState;
}

/**
 * Read the total underlying assets held by the vault (in asset stroops).
 * Returns a non-negative bigint.
 *
 * Closes #426
 */
export async function readTotalAssets(contractId: string): Promise<bigint> {
  const value = await simulateRead<bigint>(contractId, "total_assets");
  const result = BigInt(value);
  if (result < 0n) {
    throw new Error(`readTotalAssets: unexpected negative value ${result}`);
  }
  return result;
}

/**
 * Read the total supply of vault shares currently in circulation.
 * Returns a non-negative bigint.
 *
 * Closes #427
 */
export async function readTotalSupply(contractId: string): Promise<bigint> {
  const value = await simulateRead<bigint>(contractId, "total_supply");
  const result = BigInt(value);
  if (result < 0n) {
    throw new Error(`readTotalSupply: unexpected negative value ${result}`);
  }
  return result;
}

/**
 * Read the share balance of a specific user address.
 * Returns 0n for an address that has never deposited.
 *
 * Closes #428
 */
export async function readShareBalance(
  contractId: string,
  userAddress: string,
): Promise<bigint> {
  const addrArg = Address.fromString(userAddress).toScVal();
  const value = await simulateRead<bigint>(contractId, "balance", [addrArg]);
  // balance() returns 0 for unknown addresses — BigInt(0) = 0n
  return BigInt(value ?? 0);
}
