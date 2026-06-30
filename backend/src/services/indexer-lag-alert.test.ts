import { describe, it, expect, beforeEach, vi } from "vitest";
import { Indexer } from "./indexer.js";
import { logger } from "../logger.js";

vi.mock("../db/index.js", () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./stellar.js", () => ({ getSorobanRpc: vi.fn() }));
vi.mock("./vault.js", () => ({ VaultService: vi.fn().mockImplementation(() => ({})) }));
vi.mock("./user.js", () => ({
  UserService: vi.fn().mockImplementation(() => ({
    upsertUser: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("./notifications.js", () => ({ NotificationService: vi.fn().mockImplementation(() => ({})) }));
vi.mock("../config.js", () => ({
  config: {
    indexer: {
      startLedger: 0,
      pollIntervalMs: 5000,
      batchSize: 200,
      lagAlertLedgers: 100,
    },
    stellar: {
      vaultFactoryContractId: "CFACTORY",
    },
  },
}));

describe("Indexer lag alert (#672)", () => {
  let indexer: Indexer;
  let mockServer: {
    getLatestLedger: ReturnType<typeof vi.fn>;
    getEvents: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockServer = {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1000 }),
    };
    const { getSorobanRpc } = await import("./stellar.js");
    (getSorobanRpc as any).mockReturnValue(mockServer);
    indexer = new Indexer();
    indexer["lastLedger"] = 900;
  });

  it("does not log error when lag is below threshold", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 950 });

    await indexer.tick();

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs error when lag equals threshold + 1", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 1001 });
    indexer["lastLedger"] = 900;

    await indexer.tick();

    expect(logger.error).toHaveBeenCalledWith("Indexer lag: 101 ledgers behind chain tip");
  });

  it("does not log error when lag exactly equals threshold", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 1000 });
    indexer["lastLedger"] = 900;

    await indexer.tick();

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs error on every tick when lagging", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 1050 });

    for (let i = 0; i < 3; i++) {
      indexer["lastLedger"] = 900;
      await indexer.tick();
    }

    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it("uses correct threshold from config", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 1001 });
    indexer["lastLedger"] = 900;

    await indexer.tick();

    const call = (logger.error as any).mock.calls[0][0];
    expect(call).toContain("101 ledgers behind");
  });

  it("does not log when caught up", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 950 });
    indexer["lastLedger"] = 900;

    await indexer.tick();

    mockServer.getLatestLedger.mockResolvedValue({ sequence: 951 });
    await indexer.tick();

    expect(logger.error).not.toHaveBeenCalled();
  });
});
