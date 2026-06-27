import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listVaults: vi.fn(),
}));

vi.mock("../../services/vault.js", () => ({
  VaultService: vi.fn(() => ({
    listVaults: mocks.listVaults,
  })),
}));
vi.mock("../../services/stellar.js");

import { listVaults } from "./vaults.js";

describe("Vaults Controller", () => {
  const mockRes = {
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };

  const mockNext = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listVaults with state filter", () => {
    it("returns cancelled vaults when state=Cancelled is provided", async () => {
      const mockVaults = [
        {
          id: 1,
          contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          state: "Cancelled",
          totalAssets: "0",
          totalSupply: "0",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mocks.listVaults.mockResolvedValue({
        data: mockVaults,
        total: 1,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          state: "Cancelled",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockVaults,
          total: 1,
        })
      );
    });

    it("returns empty list when no cancelled vaults exist", async () => {
      mocks.listVaults.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          state: "Cancelled",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [],
          total: 0,
        })
      );
    });

    it("returns all vaults when no state filter is provided", async () => {
      const mockVaults = [
        {
          id: 1,
          contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          state: "Funding",
          totalAssets: "1000",
          totalSupply: "100",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          contractId: "CABC2SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3C",
          state: "Cancelled",
          totalAssets: "0",
          totalSupply: "0",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mocks.listVaults.mockResolvedValue({
        data: mockVaults,
        total: 2,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ state: "Funding" }),
            expect.objectContaining({ state: "Cancelled" }),
          ]),
          total: 2,
        })
      );
    });

    it("passes state to VaultService.listVaults correctly", async () => {
      mocks.listVaults.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          state: "Cancelled",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mocks.listVaults).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "Cancelled",
        })
      );
    });
  });

  describe("listVaults with search query", () => {
    it("returns vaults matching search query", async () => {
      const mockVaults = [
        {
          id: 1,
          contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          name: "Bond Vault",
          state: "Active",
          totalAssets: "1000",
          totalSupply: "100",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mocks.listVaults.mockResolvedValue({
        data: mockVaults,
        total: 1,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          q: "bond",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockVaults,
          total: 1,
        })
      );
    });

    it("passes search query to VaultService.listVaults correctly", async () => {
      mocks.listVaults.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          q: "bond",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mocks.listVaults).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "bond",
        })
      );
    });

    it("returns all vaults when q is empty string", async () => {
      const mockVaults = [
        {
          id: 1,
          contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          name: "Vault A",
          state: "Active",
          totalAssets: "1000",
          totalSupply: "100",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          contractId: "CABC2SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3C",
          name: "Vault B",
          state: "Active",
          totalAssets: "500",
          totalSupply: "50",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mocks.listVaults.mockResolvedValue({
        data: mockVaults,
        total: 2,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          q: "",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockVaults,
          total: 2,
        })
      );
    });

    it("works with both state filter and search query", async () => {
      const mockVaults = [
        {
          id: 1,
          contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          name: "Bond Vault",
          state: "Active",
          totalAssets: "1000",
          totalSupply: "100",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mocks.listVaults.mockResolvedValue({
        data: mockVaults,
        total: 1,
        page: 1,
        pageSize: 20,
      });

      const mockReq = {
        query: {
          page: 1,
          pageSize: 20,
          state: "Active",
          q: "bond",
          sort: "created_at",
          order: "desc",
        },
      };

      await listVaults(mockReq as any, mockRes as any, mockNext);

      expect(mocks.listVaults).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "Active",
          q: "bond",
        })
      );
    });
  });

  describe("README documentation", () => {
    it("includes Cancelled state documentation", async () => {
      const fs = await import("fs");
      const path = await import("path");

      const readmePath = path.join(
        process.cwd(),
        "README.md"
      );
      const readmeContent = fs.readFileSync(readmePath, "utf-8");

      expect(readmeContent).toContain("Cancelled");
      expect(readmeContent).toContain("cancel_funding");
      expect(readmeContent).toContain("state=Cancelled");
      expect(readmeContent).toContain("GET /api/v1/vaults?state=Cancelled");
    });
  });
});
