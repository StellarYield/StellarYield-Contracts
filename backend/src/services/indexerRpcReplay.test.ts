import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./stellar.js", () => ({
  getSorobanRpc: vi.fn(),
  readRwaName: vi.fn(),
  readRwaSymbol: vi.fn(),
  readRwaDocumentUri: vi.fn(),
}));
vi.mock("./vault.js", () => ({ VaultService: vi.fn().mockImplementation(() => ({})) }));
vi.mock("./user.js", () => ({
  UserService: vi.fn().mockImplementation(() => ({
    upsertUser: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("./notifications.js", () => ({ NotificationService: vi.fn().mockImplementation(() => ({})) }));
vi.mock("../cache/redis.js", () => ({
  cacheDel: vi.fn().mockResolvedValue(undefined),
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));

import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { readFileSync, readdirSync } from "node:fs";
import { Indexer } from "./indexer.js";
import { query } from "../db/index.js";
import { getSorobanRpc } from "./stellar.js";
import { VAULT_CONTRACT, USER_ADDRESS } from "../test/fixtures/events.js";
import {
  createFakeDb,
  createReplayRpc,
  loadAllRpcFixtures,
  type FakeDb,
} from "../test/rpcReplayHarness.js";

function replayIndexer(db: FakeDb) {
  const rpc = createReplayRpc(loadAllRpcFixtures());
  (query as any).mockImplementation(db.query);
  (getSorobanRpc as any).mockReturnValue(rpc);
  return { indexer: new Indexer(), rpc };
}

describe("indexer RPC replay (#1292)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays recorded getEvents responses and persists the resulting rows", async () => {
    const db = createFakeDb(VAULT_CONTRACT);
    const { indexer, rpc } = replayIndexer(db);

    await indexer.tick();

    expect(rpc.callCount).toBe(1);
    expect(db.indexedEvents.map((e) => e.event_type)).toEqual([
      "deposit",
      "yield_distributed",
      "vault_state_changed",
    ]);

    expect(db.positions).toHaveLength(1);
    expect(db.positions[0]).toMatchObject({
      user_address: USER_ADDRESS,
      vault_id: 1,
      shares: "1000",
      deposited: "1000",
    });

    expect(db.epochs).toHaveLength(1);
    expect(db.epochs[0]).toMatchObject({
      vault_id: 1,
      epoch: 1,
      yield_amount: "10000",
      total_shares: "1000",
    });

    expect(db.vaults[0].state).toBe("Active");
    expect(db.vaults[0].total_assets).toBe("1000");
  });

  it("is idempotent when the same events are replayed again", async () => {
    const db = createFakeDb(VAULT_CONTRACT);
    const { indexer } = replayIndexer(db);

    await indexer.tick();

    // Replay the exact recorded events a second time (as a resumed contract or a
    // backfill would); the de-duplication query must keep every row single.
    for (const fixture of loadAllRpcFixtures()) {
      for (const event of fixture.events) {
        await indexer.processEvent(event);
      }
    }

    expect(db.indexedEvents).toHaveLength(3);
    expect(db.positions).toHaveLength(1);
    expect(db.epochs).toHaveLength(1);
  });

  it("decodes the replayed topics and values to the expected event names", () => {
    const names = loadAllRpcFixtures().flatMap((f) =>
      f.events.map((e) => String(scValToNative(xdr.ScVal.fromXDR(e.topic[0], "base64")))),
    );

    expect(names.sort()).toEqual(["deposit", "st_chg", "yield_dis"]);
  });

  it("records fixtures with no secrets or private endpoints", () => {
    const dir = new URL("../../tests/fixtures/rpc/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const raw = readFileSync(new URL(file, dir), "utf8");
      for (const forbidden of [
        /https?:\/\//i,
        /localhost/i,
        /127\.0\.0\.1/,
        /\bsecret\b/i,
        /private[_-]?key/i,
        /S[A-Z2-7]{55}/, // Stellar secret key
      ]) {
        expect(raw).not.toMatch(forbidden);
      }
    }
  });
});
