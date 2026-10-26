import { describe, it, expect, vi, beforeEach } from "vitest";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";

vi.mock("../db/index.js", () => ({
  withTransaction: (fn: () => unknown) => fn(),
  query: vi.fn(),
  pool: {},
  readPool: null,
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    largeTransferThreshold: "1000000",
    indexer: {
      startLedger: 0,
      pollIntervalMs: 5000,
      batchSize: 200,
      lagAlertLedgers: 100,
    },
    stellar: {
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      vaultFactoryContractId: "CF111",
    },
  },
}));

import { query } from "../db/index.js";
import { logger } from "../logger.js";
import {
  Indexer,
  parseTransferEvent,
  parseTransferFeeCollectedEvent,
} from "./indexer.js";

import { Keypair } from "@stellar/stellar-sdk";

function makeTransferEvent(from: string, to: string, amount: bigint) {
  const topics = [
    xdr.ScVal.scvSymbol("transfer").toXDR("base64"),
    nativeToScVal(from, { type: "address" }).toXDR("base64"),
    nativeToScVal(to, { type: "address" }).toXDR("base64"),
  ];
  const value = nativeToScVal(amount, { type: "i128" }).toXDR("base64");
  return {
    id: "tx-xfr-1",
    contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
    ledger: 100,
    topic: topics,
    value,
  };
}

function makeFeeCollectedEvent(from: string, to: string, feeAmount: bigint) {
  const topics = [
    xdr.ScVal.scvSymbol("transfer_fee_collected").toXDR("base64"),
    nativeToScVal(from, { type: "address" }).toXDR("base64"),
    nativeToScVal(to, { type: "address" }).toXDR("base64"),
  ];
  const value = nativeToScVal(feeAmount, { type: "i128" }).toXDR("base64");
  return {
    id: "tx-fee-1",
    contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
    ledger: 101,
    topic: topics,
    value,
  };
}

describe("Transfer and Fee Indexing (#1076, #1077)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseTransferEvent", () => {
    it("parses valid transfer event topics and amount", () => {
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const raw = makeTransferEvent(from, to, 50000n);

      const parsed = parseTransferEvent(raw);
      expect(parsed).not.toBeNull();
      expect(parsed?.from).toBe(from);
      expect(parsed?.to).toBe(to);
      expect(parsed?.amount).toBe(50000n);
    });

    it("returns null for non-transfer event name", () => {
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const topics = [
        xdr.ScVal.scvSymbol("deposit").toXDR("base64"),
        nativeToScVal(from, { type: "address" }).toXDR("base64"),
        nativeToScVal(to, { type: "address" }).toXDR("base64"),
      ];
      const raw = {
        topic: topics,
        value: nativeToScVal(100n, { type: "i128" }).toXDR("base64"),
      };

      expect(parseTransferEvent(raw)).toBeNull();
    });
  });

  describe("parseTransferFeeCollectedEvent", () => {
    it("parses valid transfer_fee_collected event", () => {
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const raw = makeFeeCollectedEvent(from, to, 250n);

      const parsed = parseTransferFeeCollectedEvent(raw);
      expect(parsed).not.toBeNull();
      expect(parsed?.from).toBe(from);
      expect(parsed?.to).toBe(to);
      expect(parsed?.feeAmount).toBe(250n);
    });
  });

  describe("Indexer transfer event processing (#1077)", () => {
    it("indexes normal transfer and inserts into transfers table without alert when amount <= threshold", async () => {
      const indexer = new Indexer();
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const rawEvent = makeTransferEvent(from, to, 500000n);

      (query as any)
        .mockResolvedValueOnce([]) // deduplication check in _processEventInner
        .mockResolvedValueOnce([{ id: 10 }]) // SELECT id FROM vaults
        .mockResolvedValueOnce([]) // INSERT INTO transfers
        .mockResolvedValueOnce([]); // INSERT INTO indexed_events

      await indexer.processEvent(rawEvent);

      // Verify transfers table insert
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transfers"),
        [10, from, to, "500000", "tx-xfr-1", 100],
      );

      // Verify no transfer_alerts was inserted
      const calls = (query as any).mock.calls;
      const alertCall = calls.find((call: any[]) =>
        call[0].includes("INSERT INTO transfer_alerts"),
      );
      expect(alertCall).toBeUndefined();
    });

    it("creates LARGE_TRANSFER alert in transfer_alerts and logs warning when amount > threshold", async () => {
      const indexer = new Indexer();
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const rawEvent = makeTransferEvent(from, to, 5000000n); // Exceeds 1000000

      (query as any)
        .mockResolvedValueOnce([]) // deduplication check in _processEventInner
        .mockResolvedValueOnce([{ id: 10 }]) // SELECT id FROM vaults
        .mockResolvedValueOnce([]) // INSERT INTO transfers
        .mockResolvedValueOnce([]) // INSERT INTO transfer_alerts
        .mockResolvedValueOnce([]); // INSERT INTO indexed_events

      await indexer.processEvent(rawEvent);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: "5000000",
          threshold: "1000000",
          from,
          to,
        }),
        expect.stringContaining("Large transfer alert"),
      );

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transfer_alerts"),
        [
          10,
          rawEvent.contractId,
          "5000000",
          from,
          to,
          "tx-xfr-1",
          expect.stringContaining("5000000"),
        ],
      );
    });
  });

  describe("Indexer fee event processing (#1076)", () => {
    it("indexes transfer_fee_collected and inserts into transfer_fees table", async () => {
      const indexer = new Indexer();
      const from = Keypair.random().publicKey();
      const to = Keypair.random().publicKey();
      const rawEvent = makeFeeCollectedEvent(from, to, 750n);

      (query as any)
        .mockResolvedValueOnce([]) // deduplication check in _processEventInner
        .mockResolvedValueOnce([]) // INSERT INTO transfer_fees
        .mockResolvedValueOnce([]); // INSERT INTO indexed_events

      await indexer.processEvent(rawEvent);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transfer_fees"),
        [rawEvent.contractId, from, to, "750", "tx-fee-1", 101],
      );
    });
  });
});

