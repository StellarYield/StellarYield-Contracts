import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { AppError, ErrorCode, errorHandler, notFoundHandler } from "./errors.js";
import { getMetrics, httpErrorsTotal, recordHttpError } from "../../services/metrics.js";

function makeRes() {
  return {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
  };
}

function makeReq(path = "/api/v1/vaults/missing", route?: { path: string }) {
  return { path, route, method: "GET" };
}

async function scrapeCounter(name: string): Promise<string[]> {
  const metrics = await getMetrics();
  return metrics.split("\n").filter((line) => line.startsWith(name));
}

describe("http_errors_total (#831)", () => {
  beforeEach(() => {
    httpErrorsTotal.reset();
    vi.clearAllMocks();
  });

  it("increments the 4xx class for a 404 error response", async () => {
    const res = makeRes();
    errorHandler(
      new AppError(ErrorCode.VAULT_NOT_FOUND, "Vault not found", 404),
      makeReq("/api/v1/vaults/missing") as any,
      res as any,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(404);
    const lines = await scrapeCounter("http_errors_total");
    expect(lines.join("\n")).toContain('statusClass="4xx"');
    expect(lines.join("\n")).toContain('route="/api/v1/vaults/missing"');
  });

  it("increments the 5xx class for a 500 error response", async () => {
    const res = makeRes();
    const err = new Error("boom");
    errorHandler(err, makeReq("/api/v1/yields") as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const lines = await scrapeCounter("http_errors_total");
    expect(lines.join("\n")).toContain('statusClass="5xx"');
  });

  it("labels the metric with the matched route pattern when available", async () => {
    recordHttpError("/v1/vaults/:contractId", 422);
    const lines = await scrapeCounter("http_errors_total");
    expect(lines.join("\n")).toContain('route="/v1/vaults/:contractId"');
  });

  it("ignores non-error status codes", async () => {
    recordHttpError("/health", 200);
    recordHttpError("/health", 302);
    expect(await scrapeCounter("http_errors_total")).toEqual([]);
  });

  it("notFoundHandler forwards a 404 AppError so unmatched routes are counted", async () => {
    const next = vi.fn();
    notFoundHandler(makeReq("/api/v1/does-not-exist") as any, makeRes() as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
  });
});
