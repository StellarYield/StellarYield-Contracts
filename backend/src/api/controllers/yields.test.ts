import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { getVaultEpochs, getUserPendingYield, getYieldVolatility } = await import("./yields.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    getVaultEpochs,
    getUserPendingYield,
    getYieldVolatility,
  };
}

describe("Yield Controllers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVaultEpochs", () => {
    it("returns 200 with an array of epochs", async () => {
      const { query, getVaultEpochs } = await getTestContext();
      query
        .mockResolvedValueOnce([
          {
            id: 1,
            vault_id: 10,
            epoch: 1,
            yield_amount: "500",
            total_shares: "5000",
            distributed_at: new Date("2025-01-01"),
          },
        ])
        .mockResolvedValueOnce([]) // claim stats
        .mockResolvedValueOnce([]); // holder counts

      const req = { params: { contractId: "CC_VAULT" } } as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await getVaultEpochs(req, res, next);

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.json.mock.calls[0][0];
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].epoch).toBe(1);
      expect(body[0].yieldAmount).toBe("500");
    });

    it("returns empty array when vault has no epochs", async () => {
      const { query, getVaultEpochs } = await getTestContext();
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const req = { params: { contractId: "CC_EMPTY" } } as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await getVaultEpochs(req, res, next);

      expect(res.json).toHaveBeenCalledWith([]);
    });
  });

  describe("getUserPendingYield", () => {
    it("returns response with pendingYield string", async () => {
      const { query, getUserPendingYield } = await getTestContext();
      query
        .mockResolvedValueOnce([{ shares: "1000", last_claimed_epoch: -1 }])
        .mockResolvedValueOnce([
          { epoch: 1, yield_amount: "500", total_shares: "5000" },
        ]);

      const req = {
        params: { contractId: "CC_VAULT", userAddress: "GADDR123" },
      } as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await getUserPendingYield(req, res, next);

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.json.mock.calls[0][0];
      expect(typeof body.pendingYield).toBe("string");
      expect(body.pendingYield).toBe("100");
      expect(Array.isArray(body.epochs)).toBe(true);
    });

    it("returns pendingYield of 0 when user has no position", async () => {
      const { query, getUserPendingYield } = await getTestContext();
      query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const req = {
        params: { contractId: "CC_VAULT", userAddress: "GNEW" },
      } as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await getUserPendingYield(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.pendingYield).toBe("0");
    });
  });

  describe("getYieldVolatility (#982)", () => {
    it("returns 404 when vault is not found", async () => {
      const { query, getYieldVolatility } = await getTestContext();
      query.mockResolvedValueOnce([]); // vaultExists check

      const req = { params: { contractId: "CC_NONEXISTENT" } } as any;
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
      const next = vi.fn();

      await getYieldVolatility(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "NotFound", message: "Vault not found" });
    });

    it("returns null for vaults with fewer than 3 epochs", async () => {
      const { query, getYieldVolatility } = await getTestContext();
      query
        .mockResolvedValueOnce([{ id: 1 }]) // vaultExists check
        .mockResolvedValueOnce([{ id: 1 }]) // getYieldVolatility vault check
        .mockResolvedValueOnce([
          { yield_amount: "100" },
          { yield_amount: "100" },
        ]); // 2 epochs

      const req = { params: { contractId: "CC_VAULT" } } as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await getYieldVolatility(req, res, next);

      expect(res.json).toHaveBeenCalledWith(null);
    });

    it("returns coefficientOfVariation: 0 for identical yields across epochs", async () => {
      const { query, getYieldVolatility } = await getTestContext();
      query
        .mockResolvedValueOnce([{ id: 1 }]) // vaultExists check
        .mockResolvedValueOnce([{ id: 1 }]) // getYieldVolatility vault check
        .mockResolvedValueOnce([
          { yield_amount: "100" },
          { yield_amount: "100" },
          { yield_amount: "100" },
        ]); // 3 identical epochs

      const req = { params: { contractId: "CC_VAULT" } } as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await getYieldVolatility(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        stdDevYield: "0",
        coefficientOfVariation: 0,
        epochCount: 3,
      });
    });
  });
});

