import { Contract } from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import { scAddress, scI128 } from "./encode.js";
import type { SorobanOperation } from "./transaction.js";

/** @deprecated Use {@link buildUnsignedTransaction} with {@link SingleRwaVaultClient} / {@link VaultFactoryClient} `.call*()` helpers. */
export function buildOperation(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): SorobanOperation {
  return new Contract(contractId).call(method, ...args);
}

// ─── Single RWA Vault (common flows) ─────────────────────────────────────────

export function buildDeposit(input: {
  contractId: string;
  caller: string;
  assets: bigint;
  receiver: string;
}): SorobanOperation {
  return new Contract(input.contractId).call(
    "deposit",
    scAddress(input.caller),
    scI128(input.assets),
    scAddress(input.receiver),
  );
}

export function buildMint(input: {
  contractId: string;
  caller: string;
  shares: bigint;
  receiver: string;
}): SorobanOperation {
  return new Contract(input.contractId).call(
    "mint",
    scAddress(input.caller),
    scI128(input.shares),
    scAddress(input.receiver),
  );
}

export function buildRedeem(input: {
  contractId: string;
  caller: string;
  shares: bigint;
  receiver: string;
  owner: string;
}): SorobanOperation {
  return new Contract(input.contractId).call(
    "redeem",
    scAddress(input.caller),
    scI128(input.shares),
    scAddress(input.receiver),
    scAddress(input.owner),
  );
}

export function buildWithdraw(input: {
  contractId: string;
  caller: string;
  assets: bigint;
  receiver: string;
  owner: string;
}): SorobanOperation {
  return new Contract(input.contractId).call(
    "withdraw",
    scAddress(input.caller),
    scI128(input.assets),
    scAddress(input.receiver),
    scAddress(input.owner),
  );
}

export function buildClaimYield(input: {
  contractId: string;
  caller: string;
}): SorobanOperation {
  return new Contract(input.contractId).call("claim_yield", scAddress(input.caller));
}

export function buildDistributeYield(input: {
  contractId: string;
  caller: string;
  amount: bigint;
}): SorobanOperation {
  return new Contract(input.contractId).call(
    "distribute_yield",
    scAddress(input.caller),
    scI128(input.amount),
  );
}

export { buildUnsignedTransaction, simulateInvocation, simulateTransaction } from "./transaction.js";
export type { SorobanOperation } from "./transaction.js";
