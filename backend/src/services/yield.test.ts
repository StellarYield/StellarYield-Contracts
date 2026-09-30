import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../db/index.js");
  const { YieldService } = await import("./yield.js");
  const service = new YieldService();
  return { query: query as ReturnType<typeof vi.fn>, service };
}

describe("YieldService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVaultEpochs", () => {
    it("returns epochs for a vault contract id", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([
        {
          id: 1,
          vault_id: 10,
          epoch: 1,
          yield_amount: "1000",
          total_shares: "50000",
          distributed_at: new Date("2025-01-01"),
        },
        {
          id: 2,
          vault_id: 10,
          epoch: 2,
          yield_amount: "2000",
          total_shares: "60000",
          distributed_at: new Date("2025-02-01"),
        },
      ]);

      const epochs = await service.getVaultEpochs("CC_VAULT_1");
      expect(epochs.length).toBe(2);
      expect(epochs[0].epoch).toBe(1);
      expect(epochs[1].epoch).toBe(2);
      expect(epochs[0].yieldAmount).toBe("1000");
      expect(epochs[1].yieldAmount).toBe("2000");
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("JOIN vaults v"),
        ["CC_VAULT_1"],
      );
    });

    it("returns empty array when vault has no epochs", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      const epochs = await service.getVaultEpochs("CC_NO_EPOCHS");
      expect(epochs).toEqual([]);
    });
  });

  describe("getUserPendingYield", () => {
    it("returns zero pendingYield and no pending epochs when user has no shares", async () => {
      const { query, service } = await getTestContext();
      query
        .mockResolvedValueOnce([]) // no position row
        .mockResolvedValueOnce([
          { epoch: 1, yield_amount: "1000", total_shares: "50000" },
        ]);

      const result = await service.getUserPendingYield("CC_VAULT", "GUSER");
      expect(result.pendingYield).toBe("0");
      expect(result.epochs).toEqual([]);
      expect(result.claimedEpochs).toEqual([]);
    });

    it("returns correct pendingYield for one epoch", async () => {
      const { query, service } = await getTestContext();
      query
        .mockResolvedValueOnce([{ shares: "1000", last_claimed_epoch: -1 }])
        .mockResolvedValueOnce([
          { epoch: 1, yield_amount: "500", total_shares: "5000" },
        ]);

      const result = await service.getUserPendingYield("CC_VAULT", "GUSER");
      // 500 * 1000 / 5000 = 100
      expect(result.pendingYield).toBe("100");
      expect(result.epochs).toEqual([1]);
      expect(result.claimedEpochs).toEqual([]);
    });

    it("returns summed pendingYield across multiple epochs", async () => {
      const { query, service } = await getTestContext();
      query
        .mockResolvedValueOnce([{ shares: "1000", last_claimed_epoch: -1 }])
        .mockResolvedValueOnce([
          { epoch: 1, yield_amount: "500", total_shares: "5000" },
          { epoch: 2, yield_amount: "1000", total_shares: "5000" },
        ]);

      const result = await service.getUserPendingYield("CC_VAULT", "GUSER");
      // epoch1: 500*1000/5000=100, epoch2: 1000*1000/5000=200, total=300
      expect(result.pendingYield).toBe("300");
      expect(result.epochs).toEqual([1, 2]);
      expect(result.claimedEpochs).toEqual([]);
    });

    it("excludes already-claimed epochs from pendingYield", async () => {
      const { query, service } = await getTestContext();
      query
        .mockResolvedValueOnce([{ shares: "1000", last_claimed_epoch: 1 }])
        .mockResolvedValueOnce([
          { epoch: 1, yield_amount: "500", total_shares: "5000" },
          { epoch: 2, yield_amount: "1000", total_shares: "5000" },
        ]);

      const result = await service.getUserPendingYield("CC_VAULT", "GUSER");
      // epoch 1 is claimed, only epoch 2 counts: 1000*1000/5000=200
      expect(result.pendingYield).toBe("200");
      expect(result.epochs).toEqual([2]);
      expect(result.claimedEpochs).toEqual([1]);
    });

    it("excludes epochs that compute to zero yield", async () => {
      const { query, service } = await getTestContext();
      query
        .mockResolvedValueOnce([{ shares: "1", last_claimed_epoch: -1 }])
        .mockResolvedValueOnce([
          { epoch: 1, yield_amount: "1", total_shares: "5000" },
          { epoch: 2, yield_amount: "10000", total_shares: "5000" },
        ]);

      const result = await service.getUserPendingYield("CC_VAULT", "GUSER");
      // epoch1 floors to 0, epoch2 = 10000*1/5000=2
      expect(result.pendingYield).toBe("2");
      expect(result.epochs).toEqual([2]);
      expect(result.claimedEpochs).toEqual([]);
    });
  });

  describe("recordEpoch", () => {
    it("persists an epoch with an idempotent insert", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      await service.recordEpoch(10, 1, "1000", "50000");

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO epochs"),
        [10, 1, "1000", "50000", null],
      );
      expect(query.mock.calls[0][0]).toContain("ON CONFLICT (vault_id, epoch) DO NOTHING");
    });

    it("uses the same conflict-safe insert when the same vault and epoch are recorded twice", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      await service.recordEpoch(10, 7, "2500", "100000");
      await service.recordEpoch(10, 7, "2500", "100000");

      expect(query).toHaveBeenCalledTimes(2);
      for (const call of query.mock.calls) {
        expect(call[0]).toContain("INSERT INTO epochs");
        expect(call[0]).toContain("ON CONFLICT (vault_id, epoch) DO NOTHING");
        expect(call[1]).toEqual([10, 7, "2500", "100000", null]);
      }
    });
  });

  describe("getEpochYieldPerShare (#1071)", () => {
    it("returns yield per share and decimals for a finalized epoch", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValueOnce([
        {
          epoch: 3,
          yield_amount: "1000",
          total_shares: "50000",
          distributed_at: new Date("2026-03-01T00:00:00Z"),
        },
      ]);

      const result = await service.getEpochYieldPerShare("CC_VAULT", 3);
      expect(result).toEqual({
        epochId: 3,
        yieldPerShare: "0.020000000000000000",
        decimals: 18,
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE v.contract_id = $1 AND e.epoch = $2"),
        ["CC_VAULT", 3],
      );
    });

    it("returns null when epoch is not yet finalized (distributed_at is null)", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValueOnce([
        {
          epoch: 4,
          yield_amount: "2000",
          total_shares: "50000",
          distributed_at: null,
        },
      ]);

      const result = await service.getEpochYieldPerShare("CC_VAULT", 4);
      expect(result).toBeNull();
    });

    it("returns null when epoch is not found", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValueOnce([]);

      const result = await service.getEpochYieldPerShare("CC_VAULT", 999);
      expect(result).toBeNull();
    });
  });

});
