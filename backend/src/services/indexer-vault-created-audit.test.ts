import { describe, it, expect, vi, beforeEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

vi.mock("../db/index.js", () => ({
  withTransaction: (fn: () => unknown) => fn(),
  query: vi.fn(),
  pool: {},
  readPool: null,
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../stellar.js", () => ({
  readRwaName: vi.fn().mockResolvedValue(null),
  readRwaSymbol: vi.fn().mockResolvedValue(null),
  readRwaDocumentUri: vi.fn().mockResolvedValue(null),
}));

vi.mock("../cache/redis.js", () => ({ del: vi.fn(), cacheDel: vi.fn(), cacheGet: vi.fn(), cacheSet: vi.fn() }));

import { query } from "../db/index.js";
import { Indexer } from "./indexer.js";

const VAULT = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const FACTORY = "CF1111111111111111111111111111111111111111111111111111111111111";

function makeVaultCreatedEvent(ledger = 512) {
  const topics = [
    xdr.ScVal.scvSymbol("vault_created").toXDR("base64"),
    xdr.ScVal.scvString(VAULT).toXDR("base64"),
  ];
  const value = xdr.ScVal.scvVec([
    xdr.ScVal.scvString("USDC"),
    xdr.ScVal.scvString("Treasury Vault"),
    xdr.ScVal.scvString("TVAULT"),
  ]).toXDR("base64");

  return {
    id: "tx-vault-create-1",
    txHash: "tx-vault-create-1",
    contractId: FACTORY,
    ledger,
    topic: topics,
    value,
  };
}

function auditCalls(): any[][] {
  return (query as any).mock.calls.filter((call: any[]) =>
    String(call[0]).includes("INSERT INTO admin_audit_log"),
  );
}

/** The contract_id the vault row was written under, straight from the upsert params. */
function upsertedContractId(): unknown {
  const insert = (query as any).mock.calls.find((call: any[]) =>
    String(call[0]).includes("INSERT INTO vaults"),
  );
  return insert?.[1][0];
}

describe("vault creation audit log (#1064)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes exactly one VAULT_INDEXED entry per indexed vault creation", async () => {
    const indexer = new Indexer();

    (query as any).mockResolvedValue([]);

    await indexer.processEvent(makeVaultCreatedEvent(512));

    const calls = auditCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1][1]).toBe("VAULT_INDEXED");
    // Compliance tracing must point at the same contract the vault row uses.
    expect(calls[0][1][2]).toBe(upsertedContractId());
    expect(calls[0][1][5]).toBe(JSON.stringify({ blockNumber: 512, txHash: "tx-vault-create-1" }));
  });

  it("records the ledger as blockNumber and the transaction hash", async () => {
    const indexer = new Indexer();

    (query as any).mockResolvedValue([]);

    await indexer.processEvent(makeVaultCreatedEvent(9876));

    const details = JSON.parse(auditCalls()[0][1][5]);
    expect(details.blockNumber).toBe(9876);
    expect(details.txHash).toBe("tx-vault-create-1");
  });

  it("is idempotent on a ledger re-scan", async () => {
    const indexer = new Indexer();

    (query as any).mockResolvedValue([]);

    await indexer.processEvent(makeVaultCreatedEvent());

    const calls = auditCalls();
    expect(calls).toHaveLength(1);
    // Replay safety comes from the partial unique index, so the insert must
    // declare ON CONFLICT DO NOTHING or a backfill writes duplicates.
    expect(String(calls[0][0])).toContain("ON CONFLICT DO NOTHING");
  });
});
