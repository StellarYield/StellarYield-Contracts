import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./stellar.js", () => ({ getSorobanRpc: vi.fn() }));
vi.mock("./vault.js", () => ({ VaultService: vi.fn().mockImplementation(() => ({})) }));
vi.mock("./user.js", () => ({
  UserService: vi.fn().mockImplementation(() => ({
    upsertUser: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("./notifications.js", () => ({ NotificationService: vi.fn().mockImplementation(() => ({})) }));

import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { Indexer, eventPosition } from "./indexer.js";
import { indexerUnknownEventsTotal } from "./metrics.js";
import { getSorobanRpc } from "./stellar.js";

const VAULT_CONTRACT = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

function rawEvent(topic: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "contract",
    contractId: VAULT_CONTRACT,
    ledger: 1000,
    id: `0000000000000123456-0000000001`,
    txHash: "abc123",
    pagingToken: "",
    ledgerClosedAt: new Date().toISOString(),
    transactionIndex: 3,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [nativeToScVal(topic)],
    value: xdr.ScVal.scvVoid(),
    ...overrides,
  };
}

// ── #1214: deterministic ordering ─────────────────────────────────────────────

describe("eventPosition (#1214)", () => {
  it("parses the transaction index from the TOID portion of the event id", () => {
    // TOID = ledger * (2^20 * 2^12); tx index = TOID / 4096 % 2^20.
    const toid = ((1000n * (1n << 32n)) + (3n << 12n)).toString();
    const [txIndex, eventIndex] = eventPosition({ id: `${toid}-0000000002`, transactionIndex: 3 });
    expect(txIndex).toBe(3);
    expect(eventIndex).toBe(2);
  });

  it("falls back to the explicit transactionIndex and event 0 when id is not a TOID", () => {
    const [txIndex, eventIndex] = eventPosition({ id: "not-a-toid", transactionIndex: 7 });
    expect(txIndex).toBe(7);
    expect(eventIndex).toBe(0);
  });

  it("returns null tx index when nothing is available", () => {
    const [txIndex, eventIndex] = eventPosition({});
    expect(txIndex).toBeNull();
    expect(eventIndex).toBe(0);
  });
});

// ── #1212: unknown event types ────────────────────────────────────────────────

describe("unknown event topics (#1212)", () => {
  let indexer: Indexer;

  beforeEach(() => {
    vi.clearAllMocks();
    (getSorobanRpc as any).mockReturnValue({
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1000 }),
    });
    indexer = new Indexer();
  });

  it("increments the counter for an unrecognized topic", async () => {
    const inc = vi.spyOn(indexerUnknownEventsTotal, "inc");
    const { query } = await import("../db/index.js");
    (query as any).mockResolvedValue([]);

    await indexer.processEvent(rawEvent("totally_new_topic"));

    expect(inc).toHaveBeenCalledWith({
      contract_id: VAULT_CONTRACT,
      topic: "totally_new_topic",
    });
  });

  it("warns exactly once per topic across multiple events", async () => {
    const { logger } = await import("../logger.js");
    const { query } = await import("../db/index.js");
    (query as any).mockResolvedValue([]);

    await indexer.processEvent(rawEvent("brand_new_topic"));
    await indexer.processEvent(rawEvent("brand_new_topic"));
    await indexer.processEvent(rawEvent("brand_new_topic"));

    const warns = (logger.warn as any).mock.calls.filter((c: any[]) =>
      String(c[1]).includes("Unknown indexer event topic"),
    );
    expect(warns).toHaveLength(1);
  });

  it("does not increment the counter for a known event", async () => {
    const inc = vi.spyOn(indexerUnknownEventsTotal, "inc");
    const { query } = await import("../db/index.js");
    (query as any).mockResolvedValue([]);

    // A known but unparseable event (missing value shape) goes to dead letters,
    // not the unknown-topic counter.
    await indexer.processEvent(rawEvent("deposit"));

    expect(inc).not.toHaveBeenCalled();
  });
});

// ── #1211: dead letters ───────────────────────────────────────────────────────

describe("dead letters (#1211)", () => {
  let indexer: Indexer;

  beforeEach(() => {
    vi.clearAllMocks();
    (getSorobanRpc as any).mockReturnValue({
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1000 }),
    });
    indexer = new Indexer();
  });

  it("inserts an unparseable event into indexer_dead_letters and keeps going", async () => {
    const { query } = await import("../db/index.js");
    (query as any).mockResolvedValue([]);

    // Known topic ("deposit") whose value cannot be parsed.
    await indexer.processEvent(rawEvent("deposit"));

    const insertCall = (query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO indexer_dead_letters"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe(VAULT_CONTRACT);
  });

  it("does not throw when a parser fails unexpectedly", async () => {
    const { query } = await import("../db/index.js");
    let call = 0;
    (query as any).mockImplementation(() => {
      call += 1;
      // First call is the dedup SELECT; then throw to simulate a parse failure.
      if (call === 1) return Promise.resolve([]);
      return Promise.reject(new Error("boom"));
    });

    await expect(indexer.processEvent(rawEvent("deposit"))).resolves.not.toThrow();

    const insertCall = (query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO indexer_dead_letters"),
    );
    expect(insertCall).toBeDefined();
  });
});

// ── #1213: adaptive batch size ────────────────────────────────────────────────

describe("adaptive batch size (#1213)", () => {
  let indexer: Indexer;

  beforeEach(() => {
    vi.clearAllMocks();
    indexer = new Indexer();
  });

  it("starts at the configured batch size", () => {
    expect(indexer.getBatchSize()).toBe(200);
  });

  it("doubles after three fast batches and never exceeds the max", () => {
    // Fast batches: duration < 1000 ms.
    indexer["tuneBatchSize"](100);
    indexer["tuneBatchSize"](100);
    expect(indexer.getBatchSize()).toBe(200);
    indexer["tuneBatchSize"](100);
    expect(indexer.getBatchSize()).toBe(400);

    for (let i = 0; i < 40; i += 1) {
      indexer["tuneBatchSize"](100);
    }
    expect(indexer.getBatchSize()).toBeLessThanOrEqual(3200);
  });

  it("halves after a slow batch and never goes below the min", () => {
    indexer["tuneBatchSize"](5000);
    expect(indexer.getBatchSize()).toBe(100);
    indexer["tuneBatchSize"](5000);
    expect(indexer.getBatchSize()).toBe(50);
    indexer["tuneBatchSize"](5000);
    expect(indexer.getBatchSize()).toBe(25);
    indexer["tuneBatchSize"](5000);
    expect(indexer.getBatchSize()).toBe(25);
  });

  it("halves after a failed batch", () => {
    indexer["tuneBatchSize"](0, true);
    expect(indexer.getBatchSize()).toBe(100);
  });
});
