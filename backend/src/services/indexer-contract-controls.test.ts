import { vi, describe, it, expect, beforeEach } from "vitest";

// Issues #1106 (event-type filter), #1107 (per-contract pause/resume) and
// #1109 (throughput metrics).

vi.mock("../db/index.js", () => ({ withTransaction: (fn: () => unknown) => fn(), query: vi.fn().mockResolvedValue([]) }));
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
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    config: {
      ...actual.config,
      stellar: { ...actual.config.stellar, vaultFactoryContractId: FACTORY },
      indexer: { ...actual.config.indexer, batchSize: 100 },
    },
  };
});

import { xdr, rpc } from "@stellar/stellar-sdk";
import { Indexer, isEventTypeAllowed, resolveEventType } from "./indexer.js";
import { KNOWN_EVENT_TYPES } from "./indexerEventTypes.js";
import { getSorobanRpc } from "./stellar.js";
import { query } from "../db/index.js";
import { getMetrics, indexerEventsProcessedTotal, indexerProcessingDurationSeconds } from "./metrics.js";

const FACTORY = vi.hoisted(() => "C" + "F".repeat(55));
const VAULT_A = "C" + "A".repeat(55);
const VAULT_B = "C" + "B".repeat(55);
const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

function makeEvent(symbol: string, contractId: string, ledger = 1000): rpc.Api.EventResponse {
  return {
    type: "contract",
    contractId,
    topic: [xdr.ScVal.scvSymbol(symbol)],
    value: xdr.ScVal.scvVoid(),
    ledger,
    id: `event-${Math.random()}`,
    txHash: "abc123",
  } as unknown as rpc.Api.EventResponse;
}

type ControlRow = {
  contract_id: string;
  indexing_paused: boolean;
  paused_at_ledger: number | null;
  allowed_event_types: string[];
};

/** Routes the controls SELECT to `rows`; every other query resolves to []. */
function withControls(rows: ControlRow[]) {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes("FROM indexer_contract_state") ? rows : [],
  );
}

async function counterValue(): Promise<number> {
  return (await indexerEventsProcessedTotal.get()).values[0]?.value ?? 0;
}

async function histogramCount(): Promise<number> {
  const metric = await indexerProcessingDurationSeconds.get();
  return metric.values.find((v) => v.metricName === "indexer_processing_duration_seconds_count")?.value ?? 0;
}

describe("event type resolution (#1106)", () => {
  it("maps topic symbols onto stored event types", () => {
    expect(resolveEventType(makeEvent("yield_dis", VAULT_A))).toBe("yield_distributed");
    expect(resolveEventType(makeEvent("st_chg", VAULT_A))).toBe("vault_state_changed");
    expect(resolveEventType(makeEvent("deposit", VAULT_A))).toBe("deposit");
  });

  it("treats an empty allow-list as no filter", () => {
    expect(isEventTypeAllowed(makeEvent("withdraw", VAULT_A), [])).toBe(true);
  });

  it("matches by stored type or by topic symbol", () => {
    expect(isEventTypeAllowed(makeEvent("yield_dis", VAULT_A), ["yield_distributed"])).toBe(true);
    expect(isEventTypeAllowed(makeEvent("yield_dis", VAULT_A), ["yield_dis"])).toBe(true);
    expect(isEventTypeAllowed(makeEvent("withdraw", VAULT_A), ["deposit"])).toBe(false);
  });

  it("knows both stored types and topic symbols", () => {
    expect(KNOWN_EVENT_TYPES.has("deposit")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("yield_dis")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("yield_distributed")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("bogus")).toBe(false);
  });
});

describe("Indexer per-contract controls", () => {
  let indexer: Indexer;
  let mockServer: { getLatestLedger: ReturnType<typeof vi.fn>; getEvents: ReturnType<typeof vi.fn> };
  let inner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    withControls([]);
    mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1010 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    };
    (getSorobanRpc as any).mockReturnValue(mockServer);
    indexer = new Indexer();
    indexer["running"] = true;
    indexer.lastLedger = 1000;
    indexer["watchedContractIds"] = new Set([FACTORY, VAULT_A, VAULT_B]);
    inner = vi.fn().mockResolvedValue(true);
    (indexer as any)._processEventInner = inner;
  });

  describe("event-type filter (#1106)", () => {
    it("only processes matching event types for a filtered contract", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: null, allowed_event_types: ["deposit"] }]);
      await indexer.loadContractControls();

      const deposit = makeEvent("deposit", VAULT_A);
      await indexer.processEvent(deposit);
      await indexer.processEvent(makeEvent("withdraw", VAULT_A));

      expect(inner).toHaveBeenCalledTimes(1);
      expect(inner).toHaveBeenCalledWith(deposit);
    });

    it("leaves other contracts unfiltered", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: null, allowed_event_types: ["deposit"] }]);
      await indexer.loadContractControls();

      await indexer.processEvent(makeEvent("withdraw", VAULT_B));
      expect(inner).toHaveBeenCalledTimes(1);
    });

    it("resumes full indexing once the filter is cleared", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: null, allowed_event_types: ["deposit"] }]);
      await indexer.loadContractControls();
      await indexer.processEvent(makeEvent("withdraw", VAULT_A));
      expect(inner).not.toHaveBeenCalled();

      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: null, allowed_event_types: [] }]);
      await indexer.loadContractControls();
      await indexer.processEvent(makeEvent("withdraw", VAULT_A));
      expect(inner).toHaveBeenCalledTimes(1);
    });

    it("applies the filter on the next tick", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: null, allowed_event_types: ["deposit"] }]);
      mockServer.getEvents.mockResolvedValueOnce({
        events: [makeEvent("deposit", VAULT_A, 1005), makeEvent("withdraw", VAULT_A, 1005)],
      });

      await indexer.tick();

      expect(inner).toHaveBeenCalledTimes(1);
      expect(resolveEventType(inner.mock.calls[0][0])).toBe("deposit");
    });

    it("keeps the previous settings if the controls cannot be loaded", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: true, paused_at_ledger: 1000, allowed_event_types: [] }]);
      await indexer.loadContractControls();
      mockQuery.mockRejectedValueOnce(new Error("db down"));
      await indexer.loadContractControls();

      await indexer.processEvent(makeEvent("deposit", VAULT_A));
      expect(inner).not.toHaveBeenCalled();
    });
  });

  describe("pause / resume (#1107)", () => {
    it("excludes paused contracts from the polling filters and skips their events", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: true, paused_at_ledger: 1000, allowed_event_types: [] }]);
      mockServer.getEvents.mockResolvedValueOnce({
        events: [makeEvent("deposit", VAULT_A, 1005), makeEvent("deposit", VAULT_B, 1005)],
      });

      await indexer.tick();

      const { filters } = mockServer.getEvents.mock.calls[0][0];
      const polled = filters.flatMap((f: { contractIds: string[] }) => f.contractIds);
      expect(polled).toEqual([FACTORY, VAULT_B]);
      expect(inner).toHaveBeenCalledTimes(1);
      expect(inner.mock.calls[0][0].contractId).toBe(VAULT_B);
      expect(indexer.lastLedger).toBe(1010);
    });

    it("does not fetch unfiltered events when every watched contract is paused", async () => {
      withControls([FACTORY, VAULT_A, VAULT_B].map((id) => ({
        contract_id: id, indexing_paused: true, paused_at_ledger: 1000, allowed_event_types: [],
      })));

      await indexer.tick();

      expect(mockServer.getEvents).not.toHaveBeenCalled();
      expect(indexer.lastLedger).toBe(1010);
    });

    it("replays a resumed contract from its pause ledger, then clears the marker", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: 900, allowed_event_types: [] }]);
      const missed = makeEvent("deposit", VAULT_A, 950);
      const pastCursor = makeEvent("deposit", VAULT_A, 1005);
      mockServer.getEvents
        .mockResolvedValueOnce({ events: [missed, pastCursor] }) // replay 901–1000
        .mockResolvedValueOnce({ events: [] }) // regular tick 1001–1010
        .mockResolvedValue({ events: [] });

      await indexer.tick();

      expect(mockServer.getEvents.mock.calls[0][0]).toEqual({
        startLedger: 901,
        filters: [{ contractIds: [VAULT_A] }],
      });
      expect(inner).toHaveBeenCalledTimes(1);
      expect(inner).toHaveBeenCalledWith(missed);

      const clear = mockQuery.mock.calls.find(([sql]) => String(sql).includes("SET paused_at_ledger = NULL"));
      expect(clear?.[1]).toEqual([VAULT_A]);
      // The regular poll continues from the global cursor.
      expect(mockServer.getEvents.mock.calls.at(-1)?.[0].startLedger).toBe(1001);
    });

    it("keeps the marker for a retry when the replay fails", async () => {
      withControls([{ contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: 900, allowed_event_types: [] }]);
      vi.spyOn(indexer as any, "replayContract").mockRejectedValueOnce(new Error("rpc down"));

      await indexer.tick();

      const clear = mockQuery.mock.calls.find(([sql]) => String(sql).includes("SET paused_at_ledger = NULL"));
      expect(clear).toBeUndefined();
    });
  });

  describe("throughput metrics (#1109)", () => {
    it("increments indexer_events_processed_total once per indexed event", async () => {
      const before = await counterValue();
      await indexer.processEvent(makeEvent("deposit", VAULT_A));
      await indexer.processEvent(makeEvent("withdraw", VAULT_A));
      expect(await counterValue()).toBe(before + 2);
    });

    it("does not count duplicate, filtered or paused events", async () => {
      const before = await counterValue();
      inner.mockResolvedValueOnce(false); // duplicate / unrecognised
      await indexer.processEvent(makeEvent("deposit", VAULT_B));

      withControls([
        { contract_id: VAULT_A, indexing_paused: false, paused_at_ledger: null, allowed_event_types: ["deposit"] },
        { contract_id: VAULT_B, indexing_paused: true, paused_at_ledger: 1000, allowed_event_types: [] },
      ]);
      await indexer.loadContractControls();
      await indexer.processEvent(makeEvent("withdraw", VAULT_A));
      await indexer.processEvent(makeEvent("deposit", VAULT_B));

      expect(await counterValue()).toBe(before);
    });

    it("observes indexer_processing_duration_seconds once per tick batch", async () => {
      const before = await histogramCount();
      mockServer.getEvents.mockResolvedValueOnce({ events: [makeEvent("deposit", VAULT_A, 1005)] });

      await indexer.tick();

      expect(await histogramCount()).toBe(before + 1);
    });

    it("exposes both metrics on the /metrics output", async () => {
      const text = await getMetrics();
      expect(text).toContain("# TYPE indexer_events_processed_total counter");
      expect(text).toContain("# TYPE indexer_processing_duration_seconds histogram");
    });
  });
});
