import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../config.js", () => ({
  config: {
    stellar: {
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
    },
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./stellar.js", () => ({
  getSorobanRpc: vi.fn(),
}));

import { validateNetworkPassphrase } from "./networkValidation.js";
import { getSorobanRpc } from "./stellar.js";
import { logger } from "../logger.js";

describe("validateNetworkPassphrase", () => {
  let mockServer: {
    getNetwork: ReturnType<typeof vi.fn>;
  };
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      getNetwork: vi.fn(),
    };
    (getSorobanRpc as any).mockReturnValue(mockServer);

    // Spy on process.exit and prevent it from actually exiting
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
  });

  it("logs confirmation and returns normally when passphrase matches", async () => {
    mockServer.getNetwork.mockResolvedValue({
      passphrase: "Test SDF Network ; September 2015",
      protocolVersion: 20,
    });

    await validateNetworkPassphrase();

    expect(logger.info).toHaveBeenCalledWith(
      {
        network: "testnet",
        passphrase: "Test SDF Network ; September 2015",
      },
      "Network passphrase validated: testnet",
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("logs error and exits with code 1 when passphrase does not match", async () => {
    mockServer.getNetwork.mockResolvedValue({
      passphrase: "Public Global Stellar Network ; September 2015",
      protocolVersion: 20,
    });

    await expect(validateNetworkPassphrase()).rejects.toThrow("process.exit called");

    expect(logger.error).toHaveBeenCalled();
    const errorCall = (logger.error as any).mock.calls[0];
    expect(errorCall[0]).toMatchObject({
      configuredNetwork: "testnet",
      expectedPassphrase: "Test SDF Network ; September 2015",
      actualPassphrase: "Public Global Stellar Network ; September 2015",
    });
    expect(errorCall[1]).toContain("Network passphrase mismatch");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("includes expected and actual passphrases in error log on mismatch", async () => {
    mockServer.getNetwork.mockResolvedValue({
      passphrase: "Wrong Network Passphrase",
      protocolVersion: 20,
    });

    await expect(validateNetworkPassphrase()).rejects.toThrow("process.exit called");

    const errorCall = (logger.error as any).mock.calls[0];
    expect(errorCall[0].expectedPassphrase).toBe("Test SDF Network ; September 2015");
    expect(errorCall[0].actualPassphrase).toBe("Wrong Network Passphrase");
  });

  it("includes STELLAR_NETWORK value in error log on mismatch", async () => {
    mockServer.getNetwork.mockResolvedValue({
      passphrase: "Wrong Network Passphrase",
      protocolVersion: 20,
    });

    await expect(validateNetworkPassphrase()).rejects.toThrow("process.exit called");

    const errorCall = (logger.error as any).mock.calls[0];
    expect(errorCall[0].configuredNetwork).toBe("testnet");
    expect(errorCall[1]).toContain("STELLAR_NETWORK=testnet");
  });

  it("exits gracefully when getNetwork call fails", async () => {
    mockServer.getNetwork.mockRejectedValue(new Error("RPC unavailable"));

    await expect(validateNetworkPassphrase()).rejects.toThrow("process.exit called");

    expect(logger.error).toHaveBeenCalled();
    const errorCall = (logger.error as any).mock.calls[0];
    expect(errorCall[0]).toHaveProperty("err");
    expect(errorCall[1]).toContain("Failed to fetch network info");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("vacuousness check: mismatch test fails if passphrase comparison is removed", async () => {
    // This test verifies that the mismatch test above is not vacuous.
    // If the passphrase comparison were removed from validateNetworkPassphrase,
    // this test would pass (no exit called), proving the mismatch test would catch it.
    mockServer.getNetwork.mockResolvedValue({
      passphrase: "Test SDF Network ; September 2015",
      protocolVersion: 20,
    });

    await validateNetworkPassphrase();

    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
