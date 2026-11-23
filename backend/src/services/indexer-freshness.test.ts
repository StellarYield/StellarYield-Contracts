import { vi, describe, it, expect, beforeEach } from "vitest";

const FACTORY = vi.hoisted(() => "C" + "F".repeat(55));
const VAULT_A = "C" + "A".repeat(55);
const VAULT_B = "C" + "B".repeat(55);
const validateVaultDecimals = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../db/index.js", () => ({
  withTransaction: (fn: () => unknown) => fn(),
  query: vi.fn().mockResolvedValue([]),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./stellar.js", () => ({ getSorobanRpc: vi.fn(), readVaultDecimals: vi.fn() }));
vi.mock("./vault.js", () => ({
  VaultService: vi.fn().mockImplementation(() => ({ validateVaultDecimals })),
}));
vi.mock("./user.js", () => ({
  UserService: vi.fn().mockImplementation(() => ({ upsertUser: vi.fn() })),
}));
vi.mock("./notifications.js", () => ({
  NotificationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../cache/redis.js", () => ({ cacheDel: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    config: {
      ...actual.config,
      stellar: { ...actual.config.stellar, vaultFactoryContractId: FACTORY },
      indexer: { ...actual.config.indexer, batchSize: 100 },
    },
  };
});

import { Indexer } from "./indexer.js";
import { query } from "../db/index.js";
import { cacheDel } from "../cache/redis.js";
import { getSorobanRpc } from "./stellar.js";

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockCacheDel = cacheDel as unknown as ReturnType<typeof vi.fn>;

function makeEvent(contractId: string, ledger: number, ledgerClosedAt?: string) {
  return {
    contractId,
    ledger,
    ledgerClosedAt,
    topic: [],
    value: {},
  } as any;
}

describe("per-contract indexer freshness (#1331)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  it("writes event cursors with close times and skips paused contracts", async () => {
    const indexer = new Indexer();
    indexer["contractControls"] = new Map([
      [VAULT_B, { indexingPaused: true, pausedAtLedger: null, allowedEventTypes: [] }],
    ]);

    await indexer.saveContractIndexingCursors(
      [FACTORY, VAULT_A, VAULT_B],
      1010,
      [
        makeEvent(VAULT_A, 1007, "2026-01-15T00:00:00.000Z"),
        makeEvent(VAULT_B, 1008),
      ],
    );

    const cursorCall = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("last_indexed_ledger"),
    );
    expect(cursorCall).toBeDefined();
    expect(cursorCall?.[1]?.[0]).toEqual([VAULT_A, FACTORY]);
    expect(cursorCall?.[1]?.[1]).toEqual([1007, 1010]);
    expect((cursorCall?.[1]?.[2] as Date[])[0].toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
    expect(mockCacheDel).toHaveBeenCalledWith(`vault:${VAULT_A}`);
    expect(mockCacheDel).toHaveBeenCalledWith("vaults:list:*");
  });

  it("validates vault decimals after a successful tick", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT contract_id FROM vaults")) {
        return [{ contract_id: VAULT_A }];
      }
      return [];
    });
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1010 }),
      getEvents: vi.fn().mockResolvedValue({ events: [makeEvent(VAULT_A, 1007)] }),
    };
    (getSorobanRpc as any).mockReturnValue(server);

    const indexer = new Indexer();
    indexer.lastLedger = 1000;
    indexer["watchedContractIds"] = new Set([FACTORY, VAULT_A]);
    (indexer as any)._processEventInner = vi.fn().mockResolvedValue(true);

    await indexer.tick();

    expect(validateVaultDecimals).toHaveBeenCalledWith([VAULT_A]);
  });
});
