import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { z } from "zod";

import { validateBody, validateQuery, validateParams } from "./validate.js";

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

const bodySchema = z.object({
  amount: z.number().int().positive(),
  asset: z.string().min(1),
});

const querySchema = z.object({
  page: z.coerce.number().int().min(1),
});

const paramsSchema = z.object({
  id: z.string().uuid(),
});

describe("validateBody", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("calls next() and replaces req.body with parsed data on valid input", () => {
    const req = { body: { amount: 100, asset: "USDC" } } as Request;
    const res = mockResponse();

    validateBody(bodySchema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.body).toEqual({ amount: 100, asset: "USDC" });
  });

  it("returns 400 with `issues` and does not call next() on invalid input", () => {
    const req = { body: { amount: -5 } } as Request;
    const res = mockResponse();

    validateBody(bodySchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "ValidationError" }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(Array.isArray(payload.issues)).toBe(true);
    expect(payload.issues.length).toBeGreaterThan(0);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("validateQuery", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("calls next() and exposes parsed query on valid input", () => {
    const req = { query: { page: "3" } } as unknown as Request;
    const res = mockResponse();

    validateQuery(querySchema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.query).toEqual({ page: 3 });
  });

  it("returns 400 with `issues` and does not call next() on invalid input", () => {
    const req = { query: { page: "0" } } as unknown as Request;
    const res = mockResponse();

    validateQuery(querySchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "ValidationError" }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe("validateParams", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("calls next() on valid params", () => {
    const req = {
      params: { id: "123e4567-e89b-12d3-a456-426614174000" },
    } as unknown as Request;
    const res = mockResponse();

    validateParams(paramsSchema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 400 with `issues` on invalid params", () => {
    const req = { params: { id: "not-a-uuid" } } as unknown as Request;
    const res = mockResponse();

    validateParams(paramsSchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
