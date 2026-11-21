import { describe, it, expect, vi } from "vitest";
import { Account, BASE_FEE, Contract } from "@stellar/stellar-sdk";
import * as rpc from "@stellar/stellar-sdk/rpc";
import {
  buildUnsignedTransaction,
  simulateTransaction,
  simulateInvocation,
} from "./transaction.js";

const VALID_ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

describe("transaction helpers", () => {
  const account = new Account(VALID_ADDR, "100");
  const operation = new Contract(CONTRACT_ID).call("test_method");

  it("builds an unsigned transaction with default parameters", () => {
    const tx = buildUnsignedTransaction({
      account,
      networkPassphrase: NETWORK_PASSPHRASE,
      operation,
    });
    expect(tx).toBeDefined();
    expect(tx.fee).toBe(BASE_FEE);
  });

  it("builds an unsigned transaction with custom fee and timeout", () => {
    const tx = buildUnsignedTransaction({
      account,
      networkPassphrase: NETWORK_PASSPHRASE,
      operation,
      fee: "500",
      timeout: 60,
    });
    expect(tx).toBeDefined();
    expect(tx.fee).toBe("500");
  });

  it("simulateTransaction delegates to server.simulateTransaction", async () => {
    const mockServer = {
      simulateTransaction: vi.fn().mockResolvedValue({ status: "success" }),
    } as unknown as rpc.Server;

    const tx = buildUnsignedTransaction({
      account,
      networkPassphrase: NETWORK_PASSPHRASE,
      operation,
    });

    const res = await simulateTransaction(mockServer, tx);
    expect(res).toEqual({ status: "success" });
    expect(mockServer.simulateTransaction).toHaveBeenCalledWith(tx);
  });

  it("simulateInvocation throws on simulation error", async () => {
    const mockServer = {
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "Simulation failed with error",
      }),
    } as unknown as rpc.Server;

    vi.spyOn(rpc.Api, "isSimulationError").mockReturnValue(true);

    await expect(
      simulateInvocation({
        server: mockServer,
        account,
        networkPassphrase: NETWORK_PASSPHRASE,
        contractId: CONTRACT_ID,
        method: "test_method",
        args: [],
      }),
    ).rejects.toThrow("Simulation failed with error");
  });
});
