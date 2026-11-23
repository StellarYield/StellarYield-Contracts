import { describe, it, expect } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";
import { SingleRwaVaultClient } from "./single-rwa-vault-client.js";
import type { SorobanOperation } from "./transaction.js";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

/** Decode the contract method name and native argument values from a built operation. */
function invoked(op: SorobanOperation): { method: string; args: unknown[] } {
  const invoke = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
  return {
    method: String(invoke.functionName()),
    args: invoke.args().map((arg) => scValToNative(arg)),
  };
}

describe("SingleRwaVaultClient views", () => {
  const client = new SingleRwaVaultClient(CONTRACT_ID);

  it("builds capacity view operations", () => {
    expect(client.maxDepositHeadroom(ADDR)).toBeDefined();
    expect(client.lockUpRemaining(ADDR)).toBeDefined();
    expect(client.sharePriceBps()).toBeDefined();
  });

  it("builds claim preview view operations", () => {
    expect(client.pendingYieldBreakdown(ADDR, 10)).toBeDefined();
    expect(client.previewClaimYieldRange(ADDR, 1, 5)).toBeDefined();
    expect(client.estimateClaimCostHint(ADDR)).toBeDefined();
  });

  it("builds eligibility view operations", () => {
    expect(client.canDeposit(ADDR, 1000n)).toBeDefined();
    expect(client.canRedeem(ADDR, 500n)).toBeDefined();
    expect(client.canWithdraw(ADDR, 1000n)).toBeDefined();
    expect(client.canRequestEarlyRedemption(ADDR, 200n)).toBeDefined();
  });
});

describe("SingleRwaVaultClient epoch history views", () => {
  const client = new SingleRwaVaultClient(CONTRACT_ID);

  it("getEpochRange invokes get_epoch_range with start and end", () => {
    expect(invoked(client.getEpochRange(1, 5))).toEqual({
      method: "get_epoch_range",
      args: [1, 5],
    });
  });

  it("getEpochMetadata invokes get_epoch_metadata with the epoch", () => {
    expect(invoked(client.getEpochMetadata(3))).toEqual({
      method: "get_epoch_metadata",
      args: [3],
    });
  });

  it("pricePerShareHistory invokes price_per_share_history with the epoch", () => {
    expect(invoked(client.pricePerShareHistory(2))).toEqual({
      method: "price_per_share_history",
      args: [2],
    });
  });
});
