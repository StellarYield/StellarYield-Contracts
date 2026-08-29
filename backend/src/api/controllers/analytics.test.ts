import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));
vi.mock("../../cache/redis.js", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }));

import { getTvlAggregate, getTopPerformingVaults, getUnderperformingVaults, getApyBenchmark, getApyRanking } from "./analytics.js";

describe("GET /api/v1/analytics/tvl (#775)", () => {
  const mockNext = vi.fn();

  const buildRes = () => {
    const res: any = {};
    res.set = vi.fn().mockReturnThis();
    res.json = vi.fn().mockReturnThis();
    return res;
  };

  beforeEach(() => vi.clearAllMocks());

  it("returns the aggregate TVL, active vault count, and funding vault count", async () => {
    mocks.query.mockResolvedValue([
      { total_value_locked: "12345", active_vault_count: "3", funding_vault_count: "2" },
    ]);
    const res = buildRes();

    await getTvlAggregate({} as any, res, mockNext);

    expect(res.json).toHaveBeenCalledWith({
      totalValueLocked: "12345",
      activeVaultCount: 3,
      fundingVaultCount: 2,
    });
  });

  it("scopes the query to non-archived vaults", async () => {
    mocks.query.mockResolvedValue([
      { total_value_locked: "0", active_vault_count: "0", funding_vault_count: "0" },
    ]);
    const res = buildRes();

    await getTvlAggregate({} as any, res, mockNext);

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE archived = FALSE"));
  });

  it("sets a 30 second Cache-Control header", async () => {
    mocks.query.mockResolvedValue([
      { total_value_locked: "0", active_vault_count: "0", funding_vault_count: "0" },
    ]);
    const res = buildRes();

    await getTvlAggregate({} as any, res, mockNext);

    expect(res.set).toHaveBeenCalledWith("Cache-Control", "max-age=30");
  });

  it("defaults to zeros when there are no vaults", async () => {
    mocks.query.mockResolvedValue([]);
    const res = buildRes();

    await getTvlAggregate({} as any, res, mockNext);

    expect(res.json).toHaveBeenCalledWith({
      totalValueLocked: "0",
      activeVaultCount: 0,
      fundingVaultCount: 0,
    });
  });

  it("forwards errors to next", async () => {
    const err = new Error("db down");
    mocks.query.mockRejectedValue(err);
    const res = buildRes();

    await getTvlAggregate({} as any, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(err);
  });
});

describe("Analytics Endpoints (#983, #980, #981)", () => {
  const mockNext = vi.fn();
  const buildRes = () => {
    const res: any = {};
    res.set = vi.fn().mockReturnThis();
    res.json = vi.fn().mockReturnThis();
    return res;
  };

  beforeEach(() => vi.clearAllMocks());

  describe("GET /api/v1/analytics/vaults/top-performing (#983)", () => {
    it("returns top performing vaults sorted descending by apy30d", async () => {
      // 1st query: vaults with epoch history
      mocks.query.mockResolvedValueOnce([
        { id: 1, contract_id: "C1", name: "Vault 1", state: "Active", total_assets: "1000" },
        { id: 2, contract_id: "C2", name: "Vault 2", state: "Active", total_assets: "1000" },
      ]).mockResolvedValueOnce([
        { vault_id: 1, yield_amount: "100", distributed_at: new Date("2026-08-01") },
        { vault_id: 1, yield_amount: "100", distributed_at: new Date("2026-08-20") },
        { vault_id: 2, yield_amount: "50", distributed_at: new Date("2026-08-01") },
        { vault_id: 2, yield_amount: "50", distributed_at: new Date("2026-08-20") },
      ]);

      const req = { query: { n: "2" } } as any;
      const res = buildRes();

      await getTopPerformingVaults(req, res, mockNext);

      expect(res.json).toHaveBeenCalledOnce();
      const result = res.json.mock.calls[0][0];
      expect(result).toHaveLength(2);
      expect(result[0].contractId).toBe("C1");
      expect(result[0].apy30d).toBeGreaterThan(result[1].apy30d);
    });
  });

  describe("GET /api/v1/analytics/vaults/underperforming (#983)", () => {
    it("returns underperforming vaults sorted ascending by apy30d", async () => {
      mocks.query.mockResolvedValueOnce([
        { id: 1, contract_id: "C1", name: "Vault 1", state: "Active", total_assets: "1000" },
        { id: 2, contract_id: "C2", name: "Vault 2", state: "Active", total_assets: "1000" },
      ]).mockResolvedValueOnce([
        { vault_id: 1, yield_amount: "100", distributed_at: new Date("2026-08-01") },
        { vault_id: 1, yield_amount: "100", distributed_at: new Date("2026-08-20") },
        { vault_id: 2, yield_amount: "50", distributed_at: new Date("2026-08-01") },
        { vault_id: 2, yield_amount: "50", distributed_at: new Date("2026-08-20") },
      ]);

      const req = { query: { n: "2" } } as any;
      const res = buildRes();

      await getUnderperformingVaults(req, res, mockNext);

      expect(res.json).toHaveBeenCalledOnce();
      const result = res.json.mock.calls[0][0];
      expect(result).toHaveLength(2);
      expect(result[0].contractId).toBe("C2");
      expect(result[0].apy30d).toBeLessThan(result[1].apy30d);
    });
  });

  describe("GET /api/v1/analytics/apy/benchmark (#980)", () => {
    it("returns null averages if no qualifying vaults exist", async () => {
      mocks.query.mockResolvedValueOnce([]); // no qualifying vaults

      const req = {} as any;
      const res = buildRes();

      await getApyBenchmark(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith({
        platformAverageApy30d: null,
        platformAverageApy7d: null,
        vaultCount: 0,
      });
    });
  });

  describe("GET /api/v1/analytics/apy/ranking (#981)", () => {
    it("returns vaults ranked by apy30d", async () => {
      mocks.query.mockResolvedValueOnce([
        { id: 1, contract_id: "C1", name: "Vault 1", state: "Active", total_assets: "1000" },
      ]).mockResolvedValueOnce([
        { vault_id: 1, yield_amount: "100", distributed_at: new Date("2026-08-01") },
        { vault_id: 1, yield_amount: "100", distributed_at: new Date("2026-08-20") },
      ]);

      const req = { query: {} } as any;
      const res = buildRes();

      await getApyRanking(req, res, mockNext);

      expect(res.json).toHaveBeenCalledOnce();
      const result = res.json.mock.calls[0][0];
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty("contractId", "C1");
      expect(result[0]).toHaveProperty("apy30d");
      expect(result[0]).toHaveProperty("apy7d");
      expect(result[0]).toHaveProperty("totalAssets", "1000");
    });
  });
});

