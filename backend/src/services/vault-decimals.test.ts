import { vi, describe, it, expect, beforeEach } from "vitest";

const VAULT = "C" + "A".repeat(55);

vi.mock("../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../cache/redis.js", () => ({ cacheDel: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./stellar.js", () => ({ readVaultDecimals: vi.fn() }));

import { VaultService } from "./vault.js";
import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { cacheDel } from "../cache/redis.js";

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockWarn = logger.warn as unknown as ReturnType<typeof vi.fn>;
const mockCacheDel = cacheDel as unknown as ReturnType<typeof vi.fn>;

function routesFor(storedDecimals: number | null, storedMismatch = false) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT decimals, decimals_mismatch FROM vaults")) {
      return [{ decimals: storedDecimals, decimals_mismatch: storedMismatch }];
    }
    if (sql.includes("UPDATE vaults")) {
      return [{ contract_id: VAULT }];
    }
    return [];
  });
}

describe("vault decimals validation (#1332)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routesFor(null);
  });

  it("stores the on-chain decimals when the stored value is missing", async () => {
    routesFor(null);
    const service = new VaultService(vi.fn().mockResolvedValue(7));

    await service.upsertVault({ contractId: VAULT });

    const insertCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO vaults"));
    expect(insertCall?.[1]?.[18]).toBe(7);
    expect(insertCall?.[1]?.[19]).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("does not overwrite a mismatched stored value and warns once", async () => {
    routesFor(6);
    const readDecimals = vi.fn().mockResolvedValue(7);
    const service = new VaultService(readDecimals);

    await service.upsertVault({ contractId: VAULT });
    await service.validateVaultDecimals([VAULT]);

    const insertCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO vaults"));
    expect(insertCall?.[1]?.[18]).toBe(6);
    expect(insertCall?.[1]?.[19]).toBe(true);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      { contractId: VAULT, storedDecimals: 6, onChainDecimals: 7 },
      "Vault decimals mismatch",
    );
  });

  it("reports no mismatch when stored and on-chain values agree", async () => {
    routesFor(7);
    const service = new VaultService(vi.fn().mockResolvedValue(7));

    await service.upsertVault({ contractId: VAULT });

    const insertCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO vaults"));
    expect(insertCall?.[1]?.[18]).toBe(7);
    expect(insertCall?.[1]?.[19]).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("persists a mismatch discovered while indexing", async () => {
    routesFor(6);
    const service = new VaultService(vi.fn().mockResolvedValue(7));

    await service.validateVaultDecimals([VAULT]);

    const updateCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE vaults"));
    expect(updateCall?.[1]).toEqual([VAULT, 6, true]);
    expect(mockCacheDel).toHaveBeenCalledWith(`vault:${VAULT}`);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
