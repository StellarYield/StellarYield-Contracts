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

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Indexer, parseWhitelistUpdatedEvent } from "./indexer.js";
import { query } from "../db/index.js";

const VAULT_CONTRACT = "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557";
const INVESTOR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ADMIN = "GCRQ4LWKNNGKY2DGPY2QDDMZ5BFCNG2EHJNQ4HF2BMTF2WZT5HF2BMTF2WZ";

function makeEvent(payload: xdr.ScVal, topics: xdr.ScVal[] = [nativeToScVal(INVESTOR)]) {
  return {
    id: "evt-whitelist",
    contractId: VAULT_CONTRACT,
    type: "contract",
    ledger: 4200,
    txHash: "whitelist-tx",
    topic: [nativeToScVal("whitelist_updated"), ...topics],
    value: payload,
  };
}

describe("parseWhitelistUpdatedEvent (#1094)", () => {
  it("parses an 'added' action", () => {
    const parsed = parseWhitelistUpdatedEvent(makeEvent(nativeToScVal(["added"])));

    expect(parsed).toEqual({ address: INVESTOR, action: "added", caller: "" });
  });

  it("parses a 'removed' action", () => {
    const parsed = parseWhitelistUpdatedEvent(makeEvent(nativeToScVal(["removed"])));

    expect(parsed?.action).toBe("removed");
  });

  it("reads the caller from the third topic when the contract emits one", () => {
    const parsed = parseWhitelistUpdatedEvent(
      makeEvent(nativeToScVal(["added"]), [nativeToScVal(INVESTOR), nativeToScVal(ADMIN)]),
    );

    expect(parsed).toEqual({ address: INVESTOR, action: "added", caller: ADMIN });
  });

  it("accepts a boolean allow flag", () => {
    expect(parseWhitelistUpdatedEvent(makeEvent(nativeToScVal([true])))?.action).toBe("added");
    expect(parseWhitelistUpdatedEvent(makeEvent(nativeToScVal([false])))?.action).toBe("removed");
  });

  it("accepts a struct payload", () => {
    const parsed = parseWhitelistUpdatedEvent(makeEvent(nativeToScVal({ action: "removed" })));

    expect(parsed?.action).toBe("removed");
  });

  it("accepts a struct payload with a whitelisted flag", () => {
    const parsed = parseWhitelistUpdatedEvent(makeEvent(nativeToScVal({ whitelisted: true })));

    expect(parsed?.action).toBe("added");
  });

  it("rejects a payload whose action cannot be determined", () => {
    expect(parseWhitelistUpdatedEvent(makeEvent(nativeToScVal(["maybe"])))).toBeNull();
    expect(parseWhitelistUpdatedEvent(makeEvent(nativeToScVal([42])))).toBeNull();
  });

  it("returns null for a different event", () => {
    const event = makeEvent(nativeToScVal(["added"]));
    event.topic = [nativeToScVal("deposit"), nativeToScVal(INVESTOR)];

    expect(parseWhitelistUpdatedEvent(event)).toBeNull();
  });

  it("returns null for malformed events", () => {
    expect(parseWhitelistUpdatedEvent(null)).toBeNull();
    expect(parseWhitelistUpdatedEvent({})).toBeNull();
    expect(parseWhitelistUpdatedEvent({ topics: [] })).toBeNull();
    // Only the event name in the topics, with no address to attribute it to.
    expect(parseWhitelistUpdatedEvent({ topic: [nativeToScVal("whitelist_updated")] })).toBeNull();
  });

  it("returns null when the address topic is empty", () => {
    expect(parseWhitelistUpdatedEvent(makeEvent(nativeToScVal(["added"]), [nativeToScVal("")]))).toBeNull();
  });
});

describe("whitelist_updated indexing (#1094)", () => {
  let indexer: Indexer;
  const mockQuery = query as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    indexer = new Indexer();
  });

  it("stores one whitelist_events row per on-chain change", async () => {
    await indexer.processEvent(makeEvent(nativeToScVal(["added"])));

    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO whitelist_events"));
    expect(insert).toBeDefined();
    expect(insert?.[0]).toContain("ON CONFLICT (contract_id, tx_hash, ledger, address, action) DO NOTHING");
    expect(insert?.[1]).toEqual([VAULT_CONTRACT, INVESTOR, "added", "whitelist-tx", 4200]);
  });

  it("records removals", async () => {
    await indexer.processEvent(makeEvent(nativeToScVal(["removed"])));

    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO whitelist_events"));
    expect(insert?.[1]).toEqual([VAULT_CONTRACT, INVESTOR, "removed", "whitelist-tx", 4200]);
  });

  it("also records the event in indexed_events with the parsed payload", async () => {
    await indexer.processEvent(
      makeEvent(nativeToScVal(["added"]), [nativeToScVal(INVESTOR), nativeToScVal(ADMIN)]),
    );

    const record = mockQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO indexed_events"));
    expect(record?.[1]).toEqual([
      4200,
      "evt-whitelist",
      VAULT_CONTRACT,
      "whitelist_updated",
      expect.any(String),
      JSON.stringify({ address: INVESTOR, action: "added", caller: ADMIN }),
      null,
      0,
    ]);
  });

  it("stores a row for every change in the same transaction", async () => {
    const first = { ...makeEvent(nativeToScVal(["added"])), topic: [nativeToScVal("whitelist_updated"), nativeToScVal(INVESTOR)] };
    const second = { ...makeEvent(nativeToScVal(["removed"])), topic: [nativeToScVal("whitelist_updated"), nativeToScVal(ADMIN)] };
    second.id = "evt-whitelist-2";

    await indexer.processEvent(first);
    await indexer.processEvent(second);

    const inserts = mockQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO whitelist_events"));
    expect(inserts).toHaveLength(2);
    expect(inserts.map(([, params]) => (params as unknown[])[1])).toEqual([INVESTOR, ADMIN]);
  });

  it("drops the event when it carries no contract id", async () => {
    await indexer.processEvent({ ...makeEvent(nativeToScVal(["added"])), contractId: undefined });

    const inserts = mockQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO whitelist_events"));
    expect(inserts).toHaveLength(0);
  });

  it("leaves unrelated events alone", async () => {
    const event = { ...makeEvent(nativeToScVal(["added"])), topic: [nativeToScVal("v_pause")] };

    await indexer.processEvent(event);

    const inserts = mockQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO whitelist_events"));
    expect(inserts).toHaveLength(0);
  });
});
