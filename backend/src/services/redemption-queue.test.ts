import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/stellar.js", () => ({ getSorobanRpc: vi.fn() }));
vi.mock("../../services/notifications.js", () => ({ NotificationService: vi.fn().mockImplementation(() => ({})) }));

import { xdr } from "@stellar/stellar-sdk";
import { VaultService } from "../../services/vault.js";
import { Indexer, parseRequestEarlyRedemptionEvent } from "../../services/indexer.js";

const VAULT_CONTRACT = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ── Service tests ────────────────────────────────────────────────────────────

describe("VaultService - getRedemptionQueue", () => {
  let service: VaultService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("returns an empty array when vault has no unprocessed requests", async () => {
    const { query } = await import("../../db/index.js");
    query.mockResolvedValue([]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue).toEqual([]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("processed = FALSE"),
      [VAULT_CONTRACT],
    );
  });

  it("returns unprocessed requests ordered by request_time ASC", async () => {
    const { query } = await import("../../db/index.js");
    const now = new Date();
    const earlier = new Date(now.getTime() - 60000);
    const latest = new Date(now.getTime() + 60000);

    query.mockResolvedValue([
      {
        id: 1,
        user_address: ACCOUNT,
        shares: "100",
        request_time: earlier,
      },
      {
        id: 2,
        user_address: "GOTHER123456789",
        shares: "50",
        request_time: now,
      },
      {
        id: 3,
        user_address: "GOTHER987654321",
        shares: "200",
        request_time: latest,
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue).toHaveLength(3);
    expect(queue[0].requestTime).toEqual(earlier);
    expect(queue[1].requestTime).toEqual(now);
    expect(queue[2].requestTime).toEqual(latest);
    expect(queue[0].userAddress).toBe(ACCOUNT);
    expect(queue[0].shares).toBe("100");
  });

  it("excludes processed requests from the queue", async () => {
    const { query } = await import("../../db/index.js");
    query.mockResolvedValue([
      {
        id: 1,
        user_address: ACCOUNT,
        shares: "100",
        request_time: new Date(),
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue).toHaveLength(1);
    // The query mock filters processed = FALSE, so only unprocessed appear
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("processed = FALSE"),
      [VAULT_CONTRACT],
    );
  });

  it("returns correctly mapped field names (userAddress not user_address)", async () => {
    const { query } = await import("../../db/index.js");
    query.mockResolvedValue([
      {
        id: 42,
        user_address: ACCOUNT,
        shares: "500",
        request_time: new Date("2024-01-01T10:00:00Z"),
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue[0]).toHaveProperty("id", 42);
    expect(queue[0]).toHaveProperty("userAddress", ACCOUNT);
    expect(queue[0]).toHaveProperty("shares", "500");
    expect(queue[0]).toHaveProperty("requestTime");
  });
});

// ── Event parser tests ────────────────────────────────────────────────────────

describe("parseRequestEarlyRedemptionEvent", () => {
  it("parses a valid request_early_redemption event", () => {
    const mockEvent = {
      topic: [
        xdr.ScVal.scvSymbol("erq_req"),
        xdr.ScVal.scvAddress(xdr.Address.typeAccount(new xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 42)))),
      ],
      value: xdr.ScVal.scvVec([
        xdr.ScVal.scvU32(1),
        xdr.ScVal.scvU128(xdr.Uint128Parts.fromXDRObject({
          lo: xdr.Uint64.fromString("1000"),
          hi: xdr.Uint64.fromString("0"),
        })),
        xdr.ScVal.scvU64(xdr.Uint64.fromString("1609459200")),
      ]),
    };

    const result = parseRequestEarlyRedemptionEvent(mockEvent);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.requestId).toBe(1);
      expect(result.shares).toBe(1000n);
      expect(result.timestamp).toBe(1609459200n);
      expect(result.userAddress).toBeDefined();
    }
  });

  it("returns null for invalid event (missing topics)", () => {
    const mockEvent = {
      topic: [],
      value: xdr.ScVal.scvVoid(),
    };

    const result = parseRequestEarlyRedemptionEvent(mockEvent);
    expect(result).toBeNull();
  });

  it("returns null for wrong event name", () => {
    const mockEvent = {
      topic: [
        xdr.ScVal.scvSymbol("deposit"),
        xdr.ScVal.scvAddress(xdr.Address.typeAccount(new xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 42)))),
      ],
      value: xdr.ScVal.scvVoid(),
    };

    const result = parseRequestEarlyRedemptionEvent(mockEvent);
    expect(result).toBeNull();
  });

  it("returns null for non-object input", () => {
    const result = parseRequestEarlyRedemptionEvent(null);
    expect(result).toBeNull();
  });
});

// ── Event handler integration tests ────────────────────────────────────────────

describe("Indexer - request_early_redemption handler", () => {
  let indexer: Indexer;

  beforeEach(() => {
    vi.clearAllMocks();
    indexer = new Indexer();
  });

  it("inserts new redemption request when event is processed", async () => {
    const { query } = await import("../../db/index.js");
    
    // First call: lookup vault
    // Second call: insert redemption request
    query
      .mockResolvedValueOnce([{ id: 10 }]) // vault lookup
      .mockResolvedValueOnce([]) // insert redemption request
      .mockResolvedValueOnce([]) // check existing event
      .mockResolvedValueOnce([{ id: 0 }]); // indexed_events insert

    const mockEvent = {
      contractId: VAULT_CONTRACT,
      type: "request_early_redemption",
      ledger: 1000,
      id: "event-1",
      txHash: "hash123",
      topic: [
        xdr.ScVal.scvSymbol("request_early_redemption"),
        xdr.ScVal.scvAddress(xdr.Address.typeAccount(new xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 99)))),
      ],
      value: xdr.ScVal.scvVec([
        xdr.ScVal.scvU32(1),
        xdr.ScVal.scvU128(xdr.Uint128Parts.fromXDRObject({
          lo: xdr.Uint64.fromString("500"),
          hi: xdr.Uint64.fromString("0"),
        })),
        xdr.ScVal.scvU64(xdr.Uint64.fromString("1609459200")),
      ]),
    };

    await indexer.processEvent(mockEvent);

    // Verify the query was called with INSERT INTO redemption_requests
    const calls = (query as any).mock.calls;
    const insertCall = calls.find((c: any) => c[0].includes("INSERT INTO redemption_requests"));
    expect(insertCall).toBeDefined();
  });

  it("skips insertion when vault not found", async () => {
    const { query } = await import("../../db/index.js");
    const { logger } = await import("../../logger.js");

    // Vault not found
    query.mockResolvedValueOnce([]);

    const mockEvent = {
      contractId: "CUNKNOWN123456789",
      type: "request_early_redemption",
      ledger: 1000,
      id: "event-unknown",
      txHash: "hash456",
      topic: [
        xdr.ScVal.scvSymbol("request_early_redemption"),
        xdr.ScVal.scvAddress(xdr.Address.typeAccount(new xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 88)))),
      ],
      value: xdr.ScVal.scvVec([
        xdr.ScVal.scvU32(2),
        xdr.ScVal.scvU128(xdr.Uint128Parts.fromXDRObject({
          lo: xdr.Uint64.fromString("100"),
          hi: xdr.Uint64.fromString("0"),
        })),
        xdr.ScVal.scvU64(xdr.Uint64.fromString("1609459200")),
      ]),
    };

    await indexer.processEvent(mockEvent);

    // Should log warning about unknown vault
    expect(logger.warn).toHaveBeenCalled();
  });

  it("handles duplicate events idempotently (ON CONFLICT DO NOTHING)", async () => {
    const { query } = await import("../../db/index.js");

    // First call: vault lookup
    query
      .mockResolvedValueOnce([{ id: 10 }]) // vault lookup
      .mockResolvedValueOnce([]) // insert (should do nothing on duplicate)
      .mockResolvedValueOnce([]) // check existing event (empty, so not skipped at start)
      .mockResolvedValueOnce([{ id: 0 }]); // indexed_events insert

    const mockEvent = {
      contractId: VAULT_CONTRACT,
      type: "request_early_redemption",
      ledger: 1000,
      id: "event-dup",
      txHash: "hash789",
      topic: [
        xdr.ScVal.scvSymbol("request_early_redemption"),
        xdr.ScVal.scvAddress(xdr.Address.typeAccount(new xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32, 77)))),
      ],
      value: xdr.ScVal.scvVec([
        xdr.ScVal.scvU32(3),
        xdr.ScVal.scvU128(xdr.Uint128Parts.fromXDRObject({
          lo: xdr.Uint64.fromString("250"),
          hi: xdr.Uint64.fromString("0"),
        })),
        xdr.ScVal.scvU64(xdr.Uint64.fromString("1609459200")),
      ]),
    };

    await indexer.processEvent(mockEvent);

    // Verify ON CONFLICT ... DO NOTHING pattern in query
    const calls = (query as any).mock.calls;
    const insertCall = calls.find((c: any) => c[0].includes("ON CONFLICT"));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain("DO NOTHING");
  });
});

// ── Edge case tests ──────────────────────────────────────────────────────

describe("Redemption Queue - edge cases", () => {
  let service: VaultService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("handles very large share amounts", async () => {
    const { query } = await import("../../db/index.js");
    const largeAmount = "99999999999999999999999999.99";
    
    query.mockResolvedValue([
      {
        id: 1,
        user_address: ACCOUNT,
        shares: largeAmount,
        request_time: new Date(),
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue[0].shares).toBe(largeAmount);
  });

  it("handles multiple requests from same user in same vault", async () => {
    const { query } = await import("../../db/index.js");
    const baseTime = new Date();
    
    query.mockResolvedValue([
      {
        id: 1,
        user_address: ACCOUNT,
        shares: "100",
        request_time: baseTime,
      },
      {
        id: 2,
        user_address: ACCOUNT,
        shares: "200",
        request_time: new Date(baseTime.getTime() + 10000),
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue).toHaveLength(2);
    expect(queue[0].userAddress).toBe(ACCOUNT);
    expect(queue[1].userAddress).toBe(ACCOUNT);
  });

  it("correctly filters by vault contract ID", async () => {
    const { query } = await import("../../db/index.js");
    const otherVault = "COTHER123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    
    query.mockResolvedValue([]);

    await service.getRedemptionQueue(otherVault);

    expect(query).toHaveBeenCalledWith(
      expect.any(String),
      [otherVault],
    );
  });
});

// ── Additional happy path tests ──────────────────────────────────────────────

describe("Redemption Queue - happy path scenarios", () => {
  let service: VaultService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("single unprocessed request appears in queue", async () => {
    const { query } = await import("../../db/index.js");
    const now = new Date();
    
    query.mockResolvedValue([
      {
        id: 1,
        user_address: ACCOUNT,
        shares: "1000",
        request_time: now,
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(1);
    expect(queue[0].userAddress).toBe(ACCOUNT);
    expect(queue[0].shares).toBe("1000");
    expect(queue[0].requestTime).toEqual(now);
  });

  it("multiple requests are ordered by request_time ASC", async () => {
    const { query } = await import("../../db/index.js");
    const early = new Date("2024-01-01");
    const mid = new Date("2024-01-02");
    const late = new Date("2024-01-03");
    
    query.mockResolvedValue([
      { id: 1, user_address: "GA1", shares: "100", request_time: early },
      { id: 2, user_address: "GA2", shares: "200", request_time: mid },
      { id: 3, user_address: "GA3", shares: "300", request_time: late },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    expect(queue[0].requestTime.getTime()).toBeLessThan(queue[1].requestTime.getTime());
    expect(queue[1].requestTime.getTime()).toBeLessThan(queue[2].requestTime.getTime());
  });

  it("returns all fields for each request", async () => {
    const { query } = await import("../../db/index.js");
    const now = new Date();
    
    query.mockResolvedValue([
      {
        id: 999,
        user_address: "GTEST123456789",
        shares: "5000",
        request_time: now,
      },
    ]);

    const queue = await service.getRedemptionQueue(VAULT_CONTRACT);
    const item = queue[0];
    
    expect(Object.keys(item).sort()).toEqual(
      ["id", "requestTime", "shares", "userAddress"].sort()
    );
  });
});
