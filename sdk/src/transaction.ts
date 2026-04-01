import {
  Account,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import * as rpc from "@stellar/stellar-sdk/rpc";
import { scValToNative } from "@stellar/stellar-sdk";

export type SorobanOperation = ReturnType<Contract["call"]>;

/**
 * Build an unsigned Soroban invoke transaction (single operation).
 * Load the source account from RPC first so the sequence number is current.
 */
export function buildUnsignedTransaction(input: {
  account: Account;
  networkPassphrase: string;
  operation: SorobanOperation;
  fee?: string;
  timeout?: number;
}): Transaction {
  return new TransactionBuilder(input.account, {
    fee: input.fee ?? BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(input.operation)
    .setTimeout(input.timeout ?? 30)
    .build();
}

/**
 * Simulate a contract invocation and return the decoded return value (or `undefined`).
 * Use for read-only view functions and for preflight before `prepareTransaction` / sign.
 */
export async function simulateInvocation<T = unknown>(input: {
  server: rpc.Server;
  account: Account;
  networkPassphrase: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<T | undefined> {
  const op = new Contract(input.contractId).call(input.method, ...input.args);
  const tx = buildUnsignedTransaction({
    account: input.account,
    networkPassphrase: input.networkPassphrase,
    operation: op,
  });
  const sim = await input.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Unexpected simulation response");
  }
  const retval = sim.result?.retval;
  if (!retval) return undefined;
  return scValToNative(retval) as T;
}

/**
 * Simulate an already-built transaction (e.g. multi-op flows).
 */
export async function simulateTransaction(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<rpc.Api.SimulateTransactionResponse> {
  return server.simulateTransaction(tx);
}
