import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// The error handler logs via pino; mock it so tests stay quiet and isolated.
vi.mock("../../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { errorHandler } from "./errors.js";

interface MockResponse extends Response {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function mockResponse(): MockResponse {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const next = vi.fn();
const req = {} as Request;

describe("errorHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the error's statusCode when present (404)", () => {
    const res = mockResponse();
    const err = Object.assign(new Error("Not Found"), {
      name: "NotFoundError",
      statusCode: 404,
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("honours an arbitrary statusCode (403)", () => {
    const res = mockResponse();
    const err = Object.assign(new Error("Forbidden"), { statusCode: 403 });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("falls back to HTTP 500 when no statusCode is set", () => {
    const res = mockResponse();

    errorHandler(new Error("kaboom"), req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("response body includes both `error` and `message` fields", () => {
    const res = mockResponse();
    const err = Object.assign(new Error("Bad data"), {
      name: "ValidationError",
      statusCode: 422,
    });

    errorHandler(err, req, res, next);

    expect(res.json).toHaveBeenCalledWith({
      error: "ValidationError",
      message: "Bad data",
    });
  });

  it("defaults error name and message when the error has neither", () => {
    const res = mockResponse();
    // An error-like object with no name/message and no statusCode.
    const err = { name: undefined, message: undefined } as unknown as Error;

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "InternalServerError",
      message: "An unexpected error occurred",
    });
  });
});
