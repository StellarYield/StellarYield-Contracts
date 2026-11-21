import { describe, it, expect } from "vitest";
import { SingleRwaVaultClient } from "./single-rwa-vault-client.js";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

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
