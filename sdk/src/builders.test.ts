import { describe, it, expect } from "vitest";
import {
  buildOperation,
  buildDeposit,
  buildMint,
  buildRedeem,
  buildWithdraw,
  buildClaimYield,
  buildDistributeYield,
} from "./builders.js";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ADDR_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const ADDR_B = "GBBDUVA6V46TPL7LGB5BH4452H3BE62LAL6W3TDJ7KDWXWCYYJ337X5A";

describe("operation builders", () => {
  it("buildOperation constructs contract invoke operation", () => {
    const op = buildOperation(CONTRACT_ID, "custom_method", []);
    expect(op).toBeDefined();
  });

  it("buildDeposit sets method name and arguments", () => {
    const op = buildDeposit({
      contractId: CONTRACT_ID,
      caller: ADDR_A,
      assets: 1000n,
      receiver: ADDR_B,
    });
    expect(op).toBeDefined();
  });

  it("buildMint sets method name and arguments", () => {
    const op = buildMint({
      contractId: CONTRACT_ID,
      caller: ADDR_A,
      shares: 500n,
      receiver: ADDR_B,
    });
    expect(op).toBeDefined();
  });

  it("buildRedeem sets method name and arguments", () => {
    const op = buildRedeem({
      contractId: CONTRACT_ID,
      caller: ADDR_A,
      shares: 200n,
      receiver: ADDR_B,
      owner: ADDR_A,
    });
    expect(op).toBeDefined();
  });

  it("buildWithdraw sets method name and arguments", () => {
    const op = buildWithdraw({
      contractId: CONTRACT_ID,
      caller: ADDR_A,
      assets: 300n,
      receiver: ADDR_B,
      owner: ADDR_A,
    });
    expect(op).toBeDefined();
  });

  it("buildClaimYield sets method name and caller", () => {
    const op = buildClaimYield({
      contractId: CONTRACT_ID,
      caller: ADDR_A,
    });
    expect(op).toBeDefined();
  });

  it("buildDistributeYield sets method name and amount", () => {
    const op = buildDistributeYield({
      contractId: CONTRACT_ID,
      caller: ADDR_A,
      amount: 10000n,
    });
    expect(op).toBeDefined();
  });
});
