import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../logger.js";
import {
  rpcActiveRequests,
  rpcMonitorCallDurationSeconds,
  rpcMonitorCallsTotal,
} from "./metrics.js";
import { recordRpcError, recordRpcSuccess, startRpcCall } from "./rpcMonitor.js";

// The real counters register with a process-wide prom-client registry, which
// rejects duplicate names when the module is loaded again in these tests.
vi.mock("./metrics.js", () => ({
  rpcMonitorCallsTotal: { inc: vi.fn() },
  rpcMonitorCallDurationSeconds: { observe: vi.fn() },
  rpcActiveRequests: { inc: vi.fn(), dec: vi.fn() },
}));

// Mocked so that reloading the monitor does not start a new pino transport.
vi.mock("../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("RPC call monitoring (#1397)", () => {
  it("counts a successful call under its method label", () => {
    recordRpcSuccess("getLedgers");

    expect(rpcMonitorCallsTotal.inc).toHaveBeenCalledWith({
      method: "getLedgers",
      status: "success",
    });
  });

  it("counts a failed call under its method label", () => {
    recordRpcError("getEvents");

    expect(rpcMonitorCallsTotal.inc).toHaveBeenCalledWith({
      method: "getEvents",
      status: "error",
    });
  });

  it("skips the labelled counter when no method is given", () => {
    recordRpcSuccess();
    recordRpcError();

    expect(rpcMonitorCallsTotal.inc).not.toHaveBeenCalled();
  });

  it("tracks active requests and observes the duration when a call completes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const finish = startRpcCall("simulateTransaction");
    expect(rpcActiveRequests.inc).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    finish();

    expect(rpcMonitorCallDurationSeconds.observe).toHaveBeenCalledWith(
      { method: "simulateTransaction" },
      0.25,
    );
    expect(rpcActiveRequests.dec).toHaveBeenCalledTimes(1);
  });
});

describe("RPC error-rate alert (rolling 5-minute window)", () => {
  const WINDOW_MS = 5 * 60 * 1000;

  // The window timer only starts outside NODE_ENV=test, so each test loads a
  // fresh monitor under another environment with fake timers already installed.
  async function loadMonitor() {
    vi.resetModules();
    return import("./rpcMonitor.js");
  }

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("logs an error when the window error rate exceeds the threshold", async () => {
    const monitor = await loadMonitor();
    for (let i = 0; i < 6; i++) monitor.recordRpcError();
    for (let i = 0; i < 4; i++) monitor.recordRpcSuccess();

    vi.advanceTimersByTime(WINDOW_MS);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { windowErrors: 6, windowSuccesses: 4, total: 10, ratePct: 60 },
      "RPC error rate 60% exceeds threshold",
    );
  });

  it("does not log when the error rate equals the default threshold", async () => {
    const monitor = await loadMonitor();
    // One error in ten calls is 10%, and the default alert fires only above it.
    monitor.recordRpcError();
    for (let i = 0; i < 9; i++) monitor.recordRpcSuccess();

    vi.advanceTimersByTime(WINDOW_MS);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not log for a window with no calls", async () => {
    await loadMonitor();

    vi.advanceTimersByTime(WINDOW_MS);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("starts each window from zero counts", async () => {
    const monitor = await loadMonitor();
    for (let i = 0; i < 5; i++) monitor.recordRpcError();

    vi.advanceTimersByTime(WINDOW_MS);
    expect(logger.error).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    monitor.recordRpcSuccess();

    vi.advanceTimersByTime(WINDOW_MS);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
