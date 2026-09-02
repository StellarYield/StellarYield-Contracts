import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ connect: vi.fn(), release: vi.fn() }));

vi.mock("pg", () => {
  class FakePool {
    connect = h.connect;
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    end = vi.fn().mockResolvedValue(undefined);
    waitingCount = 0;
    constructor(_opts: unknown) {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

describe("Pool warm-up at startup (#951)", () => {
  beforeEach(() => {
    vi.resetModules();
    h.connect.mockReset();
    h.release.mockReset();
    h.connect.mockResolvedValue({ release: h.release });
    process.env["POOL_WARMUP_CONNECTIONS"] = "3";
  });

  it("opens POOL_WARMUP_CONNECTIONS connections and logs the count", async () => {
    const { warmUpPool } = await import("./index.js");
    const { logger } = await import("../logger.js");
    const info = vi.spyOn(logger, "info");

    await warmUpPool();

    expect(h.connect).toHaveBeenCalledTimes(3);
    expect(h.release).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledWith("Database pool warmed up with 3 connections");
  });

  it("logs but does not throw when warm-up fails", async () => {
    h.connect.mockRejectedValue(new Error("connection refused"));
    const { warmUpPool } = await import("./index.js");
    const { logger } = await import("../logger.js");
    const error = vi.spyOn(logger, "error");

    await expect(warmUpPool()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
