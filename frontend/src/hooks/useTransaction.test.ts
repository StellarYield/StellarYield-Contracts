import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxStage } from "../lib/soroban";
import { STAGE_LABELS, useTransaction, type TxState } from "./useTransaction";

const rpcMocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  prepareTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  getTransaction: vi.fn(),
  signTransactionWithFreighter: vi.fn(),
}));

const reactState = vi.hoisted(() => {
  let current: unknown;
  const snapshots: unknown[] = [];

  return {
    snapshots,
    reset() {
      current = undefined;
      snapshots.length = 0;
    },
    init(initial: unknown) {
      if (current === undefined) {
        current = initial;
        snapshots.push(current);
      }
      return current;
    },
    set(next: unknown) {
      current =
        typeof next === "function" ? (next as (prev: unknown) => unknown)(current) : next;
      snapshots.push(current);
      return current;
    },
  };
});

vi.mock("react", () => ({
  useState: (initial: unknown) => [reactState.init(initial), reactState.set],
  useCallback: (fn: unknown) => fn,
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Networks: {
    TESTNET: "Testnet SDF",
    FUTURENET: "Futurenet SDF",
    PUBLIC: "Public Global Stellar Network ; September 2015",
    STANDALONE: "Standalone Network ; February 2017",
  },
  Account: class {
    constructor(_accountId: string, _sequenceNumber: string) {}
  },
  Contract: class {
    constructor(_contractId: string) {}
    call(method: string, ...args: unknown[]) {
      return { method, args };
    }
  },
  Keypair: {
    random: () => ({ publicKey: () => "GTESTSOURCE" }),
  },
  TransactionBuilder: {
    fromXDR: vi.fn(() => ({ toXDR: () => "signed-transaction" })),
  },
  scValToNative: vi.fn((value: unknown) => value),
  xdr: {},
}));

vi.mock("@stellar/stellar-sdk/rpc", () => ({
  Server: class {
    getAccount = rpcMocks.getAccount;
    prepareTransaction = rpcMocks.prepareTransaction;
    sendTransaction = rpcMocks.sendTransaction;
    getTransaction = rpcMocks.getTransaction;
  },
  Api: {
    GetTransactionStatus: {
      SUCCESS: "SUCCESS",
      FAILED: "FAILED",
      NOT_FOUND: "NOT_FOUND",
    },
    isSimulationError: vi.fn(() => false),
  },
}));

vi.mock("@stellaryield/sdk", () => ({
  buildUnsignedTransaction: vi.fn(() => ({ toXDR: () => "unsigned-transaction" })),
  signTransactionWithFreighter: rpcMocks.signTransactionWithFreighter,
  describeContractError: vi.fn(() => undefined),
}));

const input = {
  action: "deposit",
  contractId: "C" + "A".repeat(55),
  method: "deposit",
  walletAddress: "G" + "A".repeat(55),
};

const reachedStages = new Set<string>();

function stageSnapshots(): TxStage[] {
  return reactState.snapshots
    .map((snapshot) => (snapshot as TxState).stage)
    .filter((stage): stage is TxStage => stage !== "idle");
}

function recordStages() {
  for (const stage of stageSnapshots()) reachedStages.add(stage);
}

beforeEach(() => {
  reactState.reset();
  vi.clearAllMocks();
  rpcMocks.getAccount.mockResolvedValue({
    accountId: input.walletAddress,
    sequenceNumber: "1",
  });
  rpcMocks.prepareTransaction.mockImplementation(async () => ({
    toXDR: () => "prepared-transaction",
  }));
  rpcMocks.signTransactionWithFreighter.mockResolvedValue({
    signedTxXdr: "signed-transaction",
  });
  rpcMocks.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "tx-hash" });
  rpcMocks.getTransaction.mockResolvedValue({ status: "SUCCESS" });
});

describe("STAGE_LABELS", () => {
  it("defines a label for every transaction stage", () => {
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([
      "awaiting-signature",
      "confirming",
      "error",
      "simulating",
      "submitting",
      "success",
    ]);
    for (const label of Object.values(STAGE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("useTransaction", () => {
  it("moves through every success stage in order", async () => {
    const onSuccess = vi.fn();
    const hook = useTransaction(onSuccess);

    await expect(hook.run(input)).resolves.toBe(true);

    expect([...new Set(stageSnapshots())]).toEqual([
      "simulating",
      "awaiting-signature",
      "submitting",
      "confirming",
      "success",
    ]);
    expect(stageSnapshots().at(-1)).toBe("success");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(rpcMocks.signTransactionWithFreighter).toHaveBeenCalledOnce();
    expect(rpcMocks.sendTransaction).toHaveBeenCalledOnce();
    recordStages();
  });

  it("ends in the failure stage when the user rejects signing", async () => {
    rpcMocks.signTransactionWithFreighter.mockRejectedValueOnce(
      new Error("User declined the transaction"),
    );
    const hook = useTransaction();

    await expect(hook.run(input)).resolves.toBe(false);

    const final = reactState.snapshots.at(-1) as TxState;
    expect(final.stage).toBe("error");
    expect(final.error).toBe("Transaction was declined in the wallet.");
    expect(final.hash).toBeNull();
    expect(stageSnapshots()).not.toContain("submitting");
    expect(rpcMocks.sendTransaction).not.toHaveBeenCalled();
    recordStages();
  });

  it("reaches every key in STAGE_LABELS across the tested flows", () => {
    expect([...reachedStages].sort()).toEqual(Object.keys(STAGE_LABELS).sort());
  });
});
