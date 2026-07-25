import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// Mock the data layer so the HTTP stack (routing, Zod validation, controller)
// runs end-to-end without a real database.
const mocks = vi.hoisted(() => ({
  getVaultEpochs: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../../services/yield.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/yield.js")>();
  return {
    ...actual,
    YieldService: vi.fn(() => ({ getVaultEpochs: mocks.getVaultEpochs })),
  };
});

import { yieldsRouter } from "./yields.js";

function buildApp() {
  const app = express();
  app.use("/api/v1/yields", yieldsRouter);
  return app;
}

const request = supertest(buildApp());

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const EPOCHS_PATH = `/api/v1/yields/${CONTRACT_ID}/epochs`;

/** The filter options the controller forwarded to YieldService.getVaultEpochs. */
function forwardedFilters() {
  return mocks.getVaultEpochs.mock.calls[0][1];
}

describe("GET /api/v1/yields/:contractId/epochs yield range validation (#858)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVaultEpochs.mockResolvedValue([]);
  });

  it("accepts a yield range and forwards both bounds as strings", async () => {
    const res = await request.get(`${EPOCHS_PATH}?minYield=100&maxYield=500`);

    expect(res.status).toBe(200);
    expect(forwardedFilters()).toMatchObject({ minYield: "100", maxYield: "500" });
  });

  it("accepts minYield on its own as an open-ended filter", async () => {
    const res = await request.get(`${EPOCHS_PATH}?minYield=100`);

    expect(res.status).toBe(200);
    expect(forwardedFilters().minYield).toBe("100");
    expect(forwardedFilters().maxYield).toBeUndefined();
  });

  it("accepts maxYield on its own as an open-ended filter", async () => {
    const res = await request.get(`${EPOCHS_PATH}?maxYield=500`);

    expect(res.status).toBe(200);
    expect(forwardedFilters().maxYield).toBe("500");
    expect(forwardedFilters().minYield).toBeUndefined();
  });

  it("forwards no bounds when neither is supplied", async () => {
    const res = await request.get(EPOCHS_PATH);

    expect(res.status).toBe(200);
    expect(forwardedFilters()).toEqual({ minYield: undefined, maxYield: undefined });
  });

  it("accepts zero as a lower bound", async () => {
    const res = await request.get(`${EPOCHS_PATH}?minYield=0`);

    expect(res.status).toBe(200);
    expect(forwardedFilters().minYield).toBe("0");
  });

  it("accepts a bound beyond Number.MAX_SAFE_INTEGER without losing precision", async () => {
    const huge = "170141183460469231731687303715884105727";
    const res = await request.get(`${EPOCHS_PATH}?maxYield=${huge}`);

    expect(res.status).toBe(200);
    expect(forwardedFilters().maxYield).toBe(huge);
  });

  it("returns 400 for a non-numeric value", async () => {
    const res = await request.get(`${EPOCHS_PATH}?minYield=abc`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(mocks.getVaultEpochs).not.toHaveBeenCalled();
  });

  it("returns 400 for a negative value", async () => {
    const res = await request.get(`${EPOCHS_PATH}?maxYield=-1`);

    expect(res.status).toBe(400);
  });

  it("returns 400 for a fractional value", async () => {
    const res = await request.get(`${EPOCHS_PATH}?minYield=1.5`);

    expect(res.status).toBe(400);
  });

  it("returns 400 when minYield exceeds maxYield", async () => {
    const res = await request.get(`${EPOCHS_PATH}?minYield=500&maxYield=100`);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("must not be greater than");
  });

  it("compares the bounds numerically, not lexicographically", async () => {
    // "9" > "10" as strings, but 9 < 10 as numbers, so this must be accepted.
    const res = await request.get(`${EPOCHS_PATH}?minYield=9&maxYield=10`);

    expect(res.status).toBe(200);
  });

  it("still accepts the pre-existing epoch parameter", async () => {
    const res = await request.get(`${EPOCHS_PATH}?epoch=3`);

    expect(res.status).toBe(200);
  });
});
