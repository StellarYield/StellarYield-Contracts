import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { getTotalSupplyConsistency } from "./admin.js";

vi.mock("../../services/vault.js", () => ({
  VaultService: vi.fn().mockImplementation(() => ({
    getVault: vi.fn(),
  })),
}));

vi.mock("../../services/stellar.js", () => ({
  readTotalSupply: vi.fn(),
}));

vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

describe("getTotalSupplyConsistency (#673)", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let mockJson: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockJson = vi.fn();
    mockStatus = vi.fn().mockReturnThis();
    mockReq = {
      query: {},
    };
    mockRes = {
      json: mockJson,
      status: mockStatus,
    };
    mockNext = vi.fn();
    vi.clearAllMocks();
  });

  it("returns consistent: true and delta: 0 when DB and chain match", async () => {
    mockReq.query = { contractId: CONTRACT_ID };

    const { VaultService } = await import("../../services/vault.js");
    const { readTotalSupply } = await import("../../services/stellar.js");

    const mockGetVault = vi.fn().mockResolvedValue({
      id: 1,
      contractId: CONTRACT_ID,
      factoryId: null,
      asset: "USDC",
      name: "Test Vault",
      symbol: "TV",
      state: "Active",
      totalAssets: "1000",
      totalSupply: "5000",
      totalSharesEverMinted: "5000",
      totalSharesEverBurned: "0",
      depositorCount: 10,
      fundingTarget: null,
      fundingDeadline: null,
      fundingProgress: null,
      minDeposit: null,
      maxDepositPerUser: null,
      zkmeVerifier: null,
      rwaName: null,
      rwaSymbol: null,
      rwaDocumentUri: null,
      rwaCategory: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(VaultService).mockReturnValue({ getVault: mockGetVault });

    vi.mocked(readTotalSupply).mockResolvedValue(5000n);

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    expect(mockJson).toHaveBeenCalledWith({
      dbTotalSupply: "5000",
      chainTotalSupply: "5000",
      delta: "0",
      consistent: true,
    });
  });

  it("returns consistent: false with negative delta when DB is ahead", async () => {
    mockReq.query = { contractId: CONTRACT_ID };

    const { VaultService } = await import("../../services/vault.js");
    const { readTotalSupply } = await import("../../services/stellar.js");

    const mockGetVault2 = vi.fn().mockResolvedValue({
      id: 1,
      contractId: CONTRACT_ID,
      factoryId: null,
      asset: "USDC",
      name: "Test Vault",
      symbol: "TV",
      state: "Active",
      totalAssets: "1000",
      totalSupply: "6000",
      totalSharesEverMinted: "6000",
      totalSharesEverBurned: "0",
      depositorCount: 10,
      fundingTarget: null,
      fundingDeadline: null,
      fundingProgress: null,
      minDeposit: null,
      maxDepositPerUser: null,
      zkmeVerifier: null,
      rwaName: null,
      rwaSymbol: null,
      rwaDocumentUri: null,
      rwaCategory: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(VaultService).mockReturnValue({ getVault: mockGetVault2 });

    vi.mocked(readTotalSupply).mockResolvedValue(5000n);

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    expect(mockJson).toHaveBeenCalledWith({
      dbTotalSupply: "6000",
      chainTotalSupply: "5000",
      delta: "-1000",
      consistent: false,
    });
  });

  it("returns consistent: false with positive delta when chain is ahead", async () => {
    mockReq.query = { contractId: CONTRACT_ID };

    const { VaultService } = await import("../../services/vault.js");
    const { readTotalSupply } = await import("../../services/stellar.js");

    const mockGetVault3 = vi.fn().mockResolvedValue({
      id: 1,
      contractId: CONTRACT_ID,
      factoryId: null,
      asset: "USDC",
      name: "Test Vault",
      symbol: "TV",
      state: "Active",
      totalAssets: "1000",
      totalSupply: "4000",
      totalSharesEverMinted: "4000",
      totalSharesEverBurned: "0",
      depositorCount: 10,
      fundingTarget: null,
      fundingDeadline: null,
      fundingProgress: null,
      minDeposit: null,
      maxDepositPerUser: null,
      zkmeVerifier: null,
      rwaName: null,
      rwaSymbol: null,
      rwaDocumentUri: null,
      rwaCategory: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(VaultService).mockReturnValue({ getVault: mockGetVault3 });

    vi.mocked(readTotalSupply).mockResolvedValue(5000n);

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    expect(mockJson).toHaveBeenCalledWith({
      dbTotalSupply: "4000",
      chainTotalSupply: "5000",
      delta: "1000",
      consistent: false,
    });
  });

  it("returns delta as string, not number", async () => {
    mockReq.query = { contractId: CONTRACT_ID };

    const { VaultService } = await import("../../services/vault.js");
    const { readTotalSupply } = await import("../../services/stellar.js");

    const mockGetVault4 = vi.fn().mockResolvedValue({
      id: 1,
      contractId: CONTRACT_ID,
      factoryId: null,
      asset: "USDC",
      name: "Test Vault",
      symbol: "TV",
      state: "Active",
      totalAssets: "1000",
      totalSupply: "5000",
      totalSharesEverMinted: "5000",
      totalSharesEverBurned: "0",
      depositorCount: 10,
      fundingTarget: null,
      fundingDeadline: null,
      fundingProgress: null,
      minDeposit: null,
      maxDepositPerUser: null,
      zkmeVerifier: null,
      rwaName: null,
      rwaSymbol: null,
      rwaDocumentUri: null,
      rwaCategory: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(VaultService).mockReturnValue({ getVault: mockGetVault4 });

    vi.mocked(readTotalSupply).mockResolvedValue(5100n);

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    const response = mockJson.mock.calls[0][0];
    expect(typeof response.delta).toBe("string");
    expect(response.delta).toBe("100");
  });

  it("returns 400 when contractId is missing", async () => {
    mockReq.query = {};

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      error: "Bad Request",
      message: "contractId query parameter is required",
    });
  });

  it("returns 404 when vault not found in database", async () => {
    mockReq.query = { contractId: CONTRACT_ID };

    const { VaultService } = await import("../../services/vault.js");
    const mockGetVaultNull = vi.fn().mockResolvedValue(null);
    vi.mocked(VaultService).mockReturnValue({ getVault: mockGetVaultNull });

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      error: "Not Found",
      message: "Vault not found",
    });
  });

  it("returns 502 when RPC call fails", async () => {
    mockReq.query = { contractId: CONTRACT_ID };

    const { VaultService } = await import("../../services/vault.js");
    const { readTotalSupply } = await import("../../services/stellar.js");

    const mockGetVault5 = vi.fn().mockResolvedValue({
      id: 1,
      contractId: CONTRACT_ID,
      factoryId: null,
      asset: "USDC",
      name: "Test Vault",
      symbol: "TV",
      state: "Active",
      totalAssets: "1000",
      totalSupply: "5000",
      totalSharesEverMinted: "5000",
      totalSharesEverBurned: "0",
      depositorCount: 10,
      fundingTarget: null,
      fundingDeadline: null,
      fundingProgress: null,
      minDeposit: null,
      maxDepositPerUser: null,
      zkmeVerifier: null,
      rwaName: null,
      rwaSymbol: null,
      rwaDocumentUri: null,
      rwaCategory: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(VaultService).mockReturnValue({ getVault: mockGetVault5 });
    vi.mocked(readTotalSupply).mockRejectedValue(new Error("RPC timeout"));

    await getTotalSupplyConsistency(mockReq as Request, mockRes as Response, mockNext);

    expect(mockStatus).toHaveBeenCalledWith(502);
    expect(mockJson).toHaveBeenCalledWith({
      error: "Bad Gateway",
      message: "Failed to fetch chain data",
    });
  });
});
