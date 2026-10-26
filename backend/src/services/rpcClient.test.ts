import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "../config.js";
import { logger, redactRpcUrl } from "../logger.js";
import { rpcCallsTotal } from "./metrics.js";
import { timedRpcCall, tryRpcEndpoints } from "./rpcClient.js";
import { recordProbeResult, RPC_HEALTH_FAILURE_THRESHOLD } from "./rpcHealth.js";

const PRIMARY = "https://primary.example";
const FALLBACK = "https://fallback.example";

describe("tryRpcEndpoints health-aware selection (#1205)", () => {
  let originalUrl: string;
  let originalFallbacks: string[];

  beforeEach(() => {
    originalUrl = config.stellar.rpcUrl;
    originalFallbacks = config.stellar.rpcFallbacks;
    config.stellar.rpcUrl = PRIMARY;
    config.stellar.rpcFallbacks = [FALLBACK];
  });

  afterEach(() => {
    config.stellar.rpcUrl = originalUrl;
    config.stellar.rpcFallbacks = originalFallbacks;
    for (const url of [PRIMARY, FALLBACK]) recordProbeResult(url, true);
  });

  it("skips an endpoint that failed consecutive health probes", async () => {
    for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) recordProbeResult(PRIMARY, false);
    const fn = vi.fn(async (url: string) => url);

    await expect(tryRpcEndpoints(fn)).resolves.toBe(FALLBACK);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(FALLBACK);
  });

  it("keeps using an endpoint that has failed fewer probes than the threshold", async () => {
    for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD - 1; i++) recordProbeResult(PRIMARY, false);

    await expect(tryRpcEndpoints(async (url) => url)).resolves.toBe(PRIMARY);
  });

  it("tries every endpoint when all of them are marked unhealthy", async () => {
    for (const url of [PRIMARY, FALLBACK]) {
      for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) recordProbeResult(url, false);
    }

    await expect(tryRpcEndpoints(async (url) => url)).resolves.toBe(PRIMARY);
  });

  it("returns to the primary once it passes a probe", async () => {
    for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) recordProbeResult(PRIMARY, false);
    recordProbeResult(PRIMARY, true);

    await expect(tryRpcEndpoints(async (url) => url)).resolves.toBe(PRIMARY);
  });

  it("logs fallback warnings without URL credentials, path or query", async () => {
    config.stellar.rpcUrl = "https://user:pw@primary.example/SECRET-PATH?api_key=abc123";
    const warn = vi.spyOn(logger, "warn");
    const fn = vi.fn(async (url: string) => {
      if (url === config.stellar.rpcUrl) throw new Error("primary down");
      return url;
    });

    await expect(tryRpcEndpoints(fn)).resolves.toBe(FALLBACK);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("https://primary.example");
    expect(logged).not.toContain("SECRET-PATH");
    expect(logged).not.toContain("abc123");
    expect(logged).not.toContain("user:pw");
    warn.mockRestore();
  });
});

describe("timedRpcCall (#1203, #1206)", () => {
  beforeEach(() => {
    rpcCallsTotal.reset();
  });

  afterEach(() => {
    config.stellar.rpcDebugLog = false;
  });

  it("counts successes and failures per method and outcome", async () => {
    await timedRpcCall("getLatestLedger", async () => 1);
    await expect(
      timedRpcCall("getLatestLedger", async () => {
        throw new Error("rpc down");
      }),
    ).rejects.toThrow("rpc down");

    const { values } = await rpcCallsTotal.get();
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { method: "getLatestLedger", outcome: "success" }, value: 1 }),
        expect.objectContaining({ labels: { method: "getLatestLedger", outcome: "error" }, value: 1 }),
      ]),
    );
  });

  it("logs method, params and response size when RPC_DEBUG_LOG is on", async () => {
    config.stellar.rpcDebugLog = true;
    const debug = vi.spyOn(logger, "debug");

    await timedRpcCall("getEvents", async () => ({ events: [] }), { startLedger: 5 });

    expect(debug).toHaveBeenCalledWith(
      {
        rpcMethod: "getEvents",
        rpcParams: { startLedger: 5 },
        outcome: "success",
        responseBytes: Buffer.byteLength('{"events":[]}'),
      },
      "RPC call",
    );
    debug.mockRestore();
  });

  it("logs nothing at debug level when RPC_DEBUG_LOG is off", async () => {
    const debug = vi.spyOn(logger, "debug");

    await timedRpcCall("getEvents", async () => ({}));

    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });
});

describe("redactRpcUrl (#1206)", () => {
  it("keeps only the origin of the endpoint", () => {
    expect(redactRpcUrl("https://user:pw@rpc.example.com:8443/tok_123/path?api_key=abc")).toBe(
      "https://rpc.example.com:8443",
    );
  });

  it("replaces an unparseable URL entirely", () => {
    expect(redactRpcUrl("not a url tok_123")).toBe("[REDACTED]");
  });
});
