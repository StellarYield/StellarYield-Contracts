import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { getArchivedVaults } from "./admin.js";

vi.mock("../../services/vault.js", () => ({
  VaultService: vi.fn().mockImplementation(() => ({
    listArchivedVaults: vi.fn(),
  })),
}));

describe("getArchivedVaults (#675)", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let mockJson: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockReq = {};
    mockJson = vi.fn();
    mockRes = {
      json: mockJson,
      status: vi.fn().mockReturnThis(),
    };
    mockNext = vi.fn();
    vi.clearAllMocks();
  });

  it("returns archived vaults ordered by updated_at DESC", async () => {
    const mockVaults = [
      {
        id: 1,
        contractId: "VAULT1",
        factoryId: null,
        asset: "USDC",
        name: "Archived Vault 1",
        symbol: "AV1",
        state: "Cancelled",
        totalAssets: "1000",
        totalSupply: "1000",
        totalSharesEverMinted: "1000",
        totalSharesEverBurned: "0",
        depositorCount: 5,
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
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-02"),
      },
      {
        id: 2,
        contractId: "VAULT2",
        factoryId: null,
        asset: "USDC",
        name: "Archived Vault 2",
        symbol: "AV2",
        state: "Cancelled",
        totalAssets: "500",
        totalSupply: "500",
        totalSharesEverMinted: "500",
        totalSharesEverBurned: "0",
        depositorCount: 2,
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
        createdAt: new Date("2024-12-01"),
        updatedAt: new Date("2025-01-01"),
      },
    ];

    const { VaultService } = await import("../../services/vault.js");
    const mockListArchivedVaults = vi.fn().mockResolvedValue(mockVaults);
    vi.mocked(VaultService).mockReturnValue({ listArchivedVaults: mockListArchivedVaults });

    await getArchivedVaults(mockReq as Request, mockRes as Response, mockNext);

    expect(mockJson).toHaveBeenCalledWith(mockVaults);
  });

  it("returns empty array when no archived vaults exist", async () => {
    const { VaultService } = await import("../../services/vault.js");
    const mockListArchivedVaults = vi.fn().mockResolvedValue([]);
    vi.mocked(VaultService).mockReturnValue({ listArchivedVaults: mockListArchivedVaults });

    await getArchivedVaults(mockReq as Request, mockRes as Response, mockNext);

    expect(mockJson).toHaveBeenCalledWith([]);
  });

  it("calls next on error", async () => {
    const error = new Error("Database error");
    const { VaultService } = await import("../../services/vault.js");
    const mockListArchivedVaults = vi.fn().mockRejectedValue(error);
    vi.mocked(VaultService).mockReturnValue({ listArchivedVaults: mockListArchivedVaults });

    await getArchivedVaults(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(error);
  });
});
