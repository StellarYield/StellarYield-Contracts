import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

import { YieldService } from "./yield.js";
import * as db from "../db/index.js";
import * as cache from "../cache/redis.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

/** SQL and bound parameters of the epoch query. */
function epochCall(): { sql: string; params: unknown[] } {
  const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
  return { sql, params };
}

describe("YieldService.getVaultEpochs yield range (#858)", () => {
  let service: YieldService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cache.cacheGet).mockResolvedValue(null);
    service = new YieldService();
    vi.mocked(db.query).mockResolvedValue([]);
  });

  it("applies both bounds when a full range is supplied", async () => {
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "100", maxYield: "500" });

    const { sql, params } = epochCall();
    expect(sql).toContain("e.yield_amount >= $2::numeric");
    expect(sql).toContain("e.yield_amount <= $3::numeric");
    expect(params).toEqual([CONTRACT_ID, "100", "500"]);
  });

  it("applies an open-ended lower bound when only minYield is supplied", async () => {
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "100" });

    const { sql, params } = epochCall();
    expect(sql).toContain("e.yield_amount >= $2::numeric");
    expect(sql).not.toContain("e.yield_amount <=");
    expect(params).toEqual([CONTRACT_ID, "100"]);
  });

  it("applies an open-ended upper bound when only maxYield is supplied", async () => {
    await service.getVaultEpochs(CONTRACT_ID, { maxYield: "500" });

    const { sql, params } = epochCall();
    expect(sql).toContain("e.yield_amount <= $2::numeric");
    expect(sql).not.toContain("e.yield_amount >=");
    expect(params).toEqual([CONTRACT_ID, "500"]);
  });

  it("leaves the query untouched when no bounds are supplied", async () => {
    await service.getVaultEpochs(CONTRACT_ID);

    const { sql, params } = epochCall();
    expect(sql).not.toContain("e.yield_amount >=");
    expect(sql).not.toContain("e.yield_amount <=");
    expect(params).toEqual([CONTRACT_ID]);
  });

  it("treats a zero lower bound as a real filter rather than an absent one", async () => {
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "0" });

    const { sql, params } = epochCall();
    expect(sql).toContain("e.yield_amount >= $2::numeric");
    expect(params).toEqual([CONTRACT_ID, "0"]);
  });

  it("keeps the yield filter inside the outer WHERE, not the lateral subquery", async () => {
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "100" });

    const { sql } = epochCall();
    // The bound must land after the vault predicate and before ORDER BY, so it
    // filters epochs rather than the yield_distributed event lookup.
    const wherePos = sql.indexOf("WHERE v.contract_id = $1");
    const filterPos = sql.indexOf("e.yield_amount >=");
    const orderPos = sql.indexOf("ORDER BY e.epoch ASC");
    expect(wherePos).toBeGreaterThan(-1);
    expect(filterPos).toBeGreaterThan(wherePos);
    expect(filterPos).toBeLessThan(orderPos);
  });

  it("binds the amounts as parameters rather than inlining them", async () => {
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "12345", maxYield: "67890" });

    const { sql } = epochCall();
    expect(sql).not.toContain("12345");
    expect(sql).not.toContain("67890");
  });

  it("keeps amounts beyond Number.MAX_SAFE_INTEGER as exact strings", async () => {
    const huge = "170141183460469231731687303715884105727";

    await service.getVaultEpochs(CONTRACT_ID, { maxYield: huge });

    expect(epochCall().params).toEqual([CONTRACT_ID, huge]);
  });

  it("varies the cache key by filter so filtered results are not served unfiltered", async () => {
    await service.getVaultEpochs(CONTRACT_ID);
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "100" });
    await service.getVaultEpochs(CONTRACT_ID, { minYield: "100", maxYield: "500" });

    const keys = vi.mocked(cache.cacheGet).mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(3);
    // Invalidation uses the `epochs:*` wildcard, so every key must stay under it.
    expect(keys.every((key) => key.startsWith("epochs:"))).toBe(true);
  });

  it("serves a cached result for a repeated identical filter", async () => {
    const cachedEpochs = [{ id: 1, vaultId: 10, epoch: 1, yieldAmount: "200" }];
    vi.mocked(cache.cacheGet).mockResolvedValue(cachedEpochs);

    const result = await service.getVaultEpochs(CONTRACT_ID, { minYield: "100" });

    expect(result).toEqual(cachedEpochs);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns only the rows the database matched", async () => {
    vi.mocked(db.query).mockResolvedValue([
      {
        id: 2,
        vault_id: 10,
        epoch: 2,
        yield_amount: "300",
        total_shares: "1000",
        distributed_at: new Date("2025-02-01"),
        net_yield: null,
      },
    ]);

    const epochs = await service.getVaultEpochs(CONTRACT_ID, {
      minYield: "100",
      maxYield: "500",
    });

    expect(epochs).toHaveLength(1);
    expect(epochs[0].epoch).toBe(2);
    expect(epochs[0].yieldAmount).toBe("300");
  });
});
