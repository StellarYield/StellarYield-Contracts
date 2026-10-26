import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { AppError, ErrorCode, errorHandler, problemTypeForCode } from "./errors.js";
import { rememberStaleResponse, resetStaleResponsesForTests } from "./staleResponse.js";

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as any;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: "GET", path: "/api/v1/vaults", originalUrl: "/api/v1/vaults", ...overrides } as unknown as Request;
}

function dbDownError(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
}

describe("errorHandler database outage (#1254, #1253)", () => {
  beforeEach(() => {
    resetStaleResponsesForTests();
  });

  it("serves the stored copy when the database is unreachable", () => {
    rememberStaleResponse("/api/v1/vaults", '{"items":["cached"]}');
    const res = makeRes();

    errorHandler(dbDownError(), makeReq(), res, vi.fn());

    expect(res.set).toHaveBeenCalledWith("X-Cache", "STALE");
    expect(res.set).toHaveBeenCalledWith("Warning", '110 - "Response is Stale"');
    expect(res.send).toHaveBeenCalledWith('{"items":["cached"]}');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("answers 503 with Retry-After when there is no stored copy", () => {
    const res = makeRes();

    errorHandler(dbDownError(), makeReq(), res, vi.fn());

    expect(res.set).toHaveBeenCalledWith("Retry-After", "30");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE, statusCode: 503 }),
    );
  });

  it("does not serve a stale copy to an authenticated request", () => {
    rememberStaleResponse("/api/v1/vaults", '{"items":["cached"]}');
    const res = makeRes();

    errorHandler(dbDownError(), makeReq({ apiKey: { id: 7 } }), res, vi.fn());

    expect(res.send).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("adds Retry-After to any 503 AppError", () => {
    const res = makeRes();

    errorHandler(new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "down for maintenance", 503), makeReq(), res, vi.fn());

    expect(res.set).toHaveBeenCalledWith("Retry-After", "30");
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("leaves non-503 errors without Retry-After", () => {
    const res = makeRes();

    errorHandler(new AppError(ErrorCode.VAULT_NOT_FOUND, "missing", 404), makeReq(), res, vi.fn());

    expect(res.set).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("RFC 7807 problem details (#1178)", () => {
  it("emits application/problem+json for a 404 with request ID in instance", () => {
    const res = makeRes();

    errorHandler(
      new AppError(ErrorCode.NOT_FOUND, "Route GET /nope not found", 404),
      makeReq({ requestId: "11111111-1111-4111-8111-111111111111" }),
      res,
      vi.fn(),
    );

    expect(res.type).toHaveBeenCalledWith("application/problem+json");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "/problems/not-found",
        title: "Not Found",
        status: 404,
        detail: "Route GET /nope not found",
        instance: "/requests/11111111-1111-4111-8111-111111111111",
        code: ErrorCode.NOT_FOUND,
        statusCode: 404,
        message: "Route GET /nope not found",
      }),
    );
  });

  it("maps every error code to a /problems/ type URI", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(problemTypeForCode(code)).toMatch(/^\/problems\/[a-z0-9-]+$/);
    }
  });

  it("uses application/problem+json for the 503 database-unavailable response", () => {
    const res = makeRes();

    errorHandler(dbDownError(), makeReq({ requestId: "req-123" }), res, vi.fn());

    expect(res.type).toHaveBeenCalledWith("application/problem+json");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "/problems/service-unavailable",
        status: 503,
        instance: "/requests/req-123",
        code: ErrorCode.SERVICE_UNAVAILABLE,
      }),
    );
  });
});
