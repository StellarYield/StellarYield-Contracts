/**
 * E2E test for deposit indexing flow (#523)
 *
 * Pipeline: synthetic deposit event → indexer.processEvent → DB →
 *           GET /api/v1/users/:address/portfolio
 *
 * The DB layer is mocked (consistent with CI — no live postgres required).
 * For a live-DB run, start docker-compose.test.yml first and set DATABASE_URL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db/index.js", () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}));
vi.mock("./services/stellar.js", () => ({ getSorobanRpc: vi.fn() }));
vi.mock("./services/vault.js", () => ({
  VaultService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("./services/notifications.js", () => ({
  NotificationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

import { nativeToScVal } from "@stellar/stellar-sdk";
import { Indexer } from "./services/indexer.js";
import { createApp } from "./app.js";

const VAULT_CONTRACT = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
// Valid 56-char Stellar address: G + 55 chars from base32 alphabet [A-Z2-7]
const USER_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2";

/** Build a synthetic deposit event in the shape processEvent expects. */
function makeDepositEvent(assets: bigint, shares: bigint) {
  return {
    id: "e2e-deposit-001",
    txHash: "e2e-deposit-001",
    contractId: VAULT_CONTRACT,
    type: "contract",
    ledger: 500,
    topic: [
      nativeToScVal("deposit"),
      nativeToScVal(USER_ADDRESS),
      nativeToScVal(USER_ADDRESS),
    ],
    value: nativeToScVal([assets, shares]),
  };
}

describe("E2E: deposit indexing flow (#523)", () => {
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { query } = await import("./db/index.js");
    queryMock = query as ReturnType<typeof vi.fn>;
    // Default: no duplicate event found, no vault row needed
    queryMock.mockResolvedValue([]);
  });

  it("processEvent inserts into indexed_events and user_vault_positions", async () => {
    const indexer = new Indexer();
    const event = makeDepositEvent(1_000n, 1_000n);

    await indexer.processEvent(event);

    const sqls: string[] = queryMock.mock.calls.map((c) => String(c[0]));

    // Duplicate-check query
    expect(sqls.some((s) => s.includes("indexed_events") && s.includes("SELECT"))).toBe(true);
    // Position upsert
    expect(sqls.some((s) => s.includes("user_vault_positions"))).toBe(true);
    // Event record insert
    expect(sqls.some((s) => s.includes("INSERT INTO indexed_events"))).toBe(true);
  });

  it("GET /api/v1/users/:address/portfolio reflects the deposit", async () => {
    // Simulate DB returning a position that was created by the indexer
    queryMock.mockResolvedValue([
      {
        id: 1,
        user_address: USER_ADDRESS,
        vault_id: 42,
        shares: "1000",
        deposited: "1000",
        last_claimed_epoch: 0,
        updated_at: new Date(),
      },
    ]);

    const { default: supertest } = await import("supertest");
    const app = createApp();
    const res = await supertest(app)
      .get(`/api/v1/users/${USER_ADDRESS}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("positions");
    expect(res.body.positions.length).toBeGreaterThan(0);
    expect(res.body.positions[0].shares).toBe("1000");
    expect(res.body.positions[0].deposited).toBe("1000");
    expect(res.body.totalDeposited).toBe("1000");
  });

  it("full pipeline: event → processEvent → portfolio shows deposit", async () => {
    // Step 1: processEvent — DB returns empty (no duplicate, no vault row)
    queryMock.mockResolvedValue([]);
    const indexer = new Indexer();
    await indexer.processEvent(makeDepositEvent(2_500n, 2_500n));

    // Verify position upsert was called with correct values
    const upsertCall = queryMock.mock.calls.find(
      (c) => String(c[0]).includes("user_vault_positions") && String(c[0]).includes("INSERT"),
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall![1]).toContain(USER_ADDRESS);
    expect(upsertCall![1]).toContain("2500"); // shares
    expect(upsertCall![1]).toContain("2500"); // deposited

    // Step 2: portfolio API — DB now returns the persisted position
    queryMock.mockResolvedValue([
      {
        id: 1,
        user_address: USER_ADDRESS,
        vault_id: 42,
        shares: "2500",
        deposited: "2500",
        last_claimed_epoch: 0,
        updated_at: new Date(),
      },
    ]);

    const { default: supertest } = await import("supertest");
    const app = createApp();
    const res = await supertest(app)
      .get(`/api/v1/users/${USER_ADDRESS}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body.positions[0].shares).toBe("2500");
    expect(res.body.totalDeposited).toBe("2500");
  });
});
