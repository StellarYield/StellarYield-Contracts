import { describe, it, expect, afterEach } from "vitest";
import { config, parseRpcTimeoutOverrides } from "../config.js";
import { rpcTimeoutFor, withRpcTimeout } from "./rpcClient.js";

const originalOverrides = { ...config.stellar.rpcTimeoutsMs };
const originalGlobal = config.stellar.rpcTimeoutMs;

afterEach(() => {
  config.stellar.rpcTimeoutsMs = originalOverrides;
  config.stellar.rpcTimeoutMs = originalGlobal;
});

describe("parseRpcTimeoutOverrides (#1207)", () => {
  it("parses a JSON object of method timeouts", () => {
    expect(parseRpcTimeoutOverrides('{"getEvents":30000,"getLatestLedger":2000}')).toEqual({
      getEvents: 30000,
      getLatestLedger: 2000,
    });
  });

  it("returns an empty map for an empty object", () => {
    expect(parseRpcTimeoutOverrides("{}")).toEqual({});
  });

  it("rejects malformed JSON", () => {
    expect(() => parseRpcTimeoutOverrides("{not json")).toThrow("RPC_TIMEOUTS_MS must be a JSON object");
  });

  it("rejects arrays and non-object JSON", () => {
    expect(() => parseRpcTimeoutOverrides("[1000]")).toThrow("RPC_TIMEOUTS_MS must be a JSON object");
    expect(() => parseRpcTimeoutOverrides("5000")).toThrow("RPC_TIMEOUTS_MS must be a JSON object");
  });

  it("rejects values below 1000ms or non-integer values", () => {
    expect(() => parseRpcTimeoutOverrides('{"getEvents":999}')).toThrow("RPC_TIMEOUTS_MS.getEvents");
    expect(() => parseRpcTimeoutOverrides('{"getEvents":1500.5}')).toThrow("RPC_TIMEOUTS_MS.getEvents");
    expect(() => parseRpcTimeoutOverrides('{"getEvents":"30000"}')).toThrow("RPC_TIMEOUTS_MS.getEvents");
  });
});

describe("rpcTimeoutFor (#1207)", () => {
  it("uses the per-method override when one is configured", () => {
    config.stellar.rpcTimeoutsMs = { getEvents: 30000 };
    config.stellar.rpcTimeoutMs = 10000;
    expect(rpcTimeoutFor("getEvents")).toBe(30000);
  });

  it("falls back to the global timeout for methods without an override", () => {
    config.stellar.rpcTimeoutsMs = { getEvents: 30000 };
    config.stellar.rpcTimeoutMs = 10000;
    expect(rpcTimeoutFor("getLatestLedger")).toBe(10000);
  });
});

describe("withRpcTimeout (#1207)", () => {
  it("resolves with the call result when it settles in time", async () => {
    config.stellar.rpcTimeoutsMs = { getLatestLedger: 1000 };
    await expect(withRpcTimeout("getLatestLedger", async () => 42)).resolves.toBe(42);
  });

  it("rejects with a timeout error when the call runs past the method's timeout", async () => {
    config.stellar.rpcTimeoutsMs = { getLatestLedger: 1000 };
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 5000));
    await expect(withRpcTimeout("getLatestLedger", () => slow)).rejects.toThrow(
      "RPC call timed out after 1000ms",
    );
  }, 10000);
});
