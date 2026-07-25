import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// Mock the data layer so the HTTP stack (routing, Zod validation, controller)
// runs end-to-end without a real database or Stellar RPC.
const mocks = vi.hoisted(() => ({
  listVaults: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../../services/stellar.js");

// Only VaultService is stubbed — the router imports the real `parseVaultSort`
// from this module to validate the `sort` parameter.
vi.mock("../../services/vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/vault.js")>();
  return {
    ...actual,
    VaultService: vi.fn(() => ({ listVaults: mocks.listVaults })),
  };
});

import { vaultsRouter } from "./vaults.js";

function buildApp() {
  const app = express();
  app.use("/api/v1/vaults", vaultsRouter);
  return app;
}

const request = supertest(buildApp());

/** The options object the controller forwarded to VaultService.listVaults. */
function forwardedOptions() {
  return mocks.listVaults.mock.calls[0][0];
}

describe("GET /api/v1/vaults sort validation (#855)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listVaults.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
  });

  it("accepts a multi-field sort and forwards it to the service", async () => {
    const res = await request.get("/api/v1/vaults?sort=state:asc,total_assets:desc");

    expect(res.status).toBe(200);
    expect(forwardedOptions().sort).toBe("state:asc,total_assets:desc");
  });

  it("accepts up to three sort fields", async () => {
    const res = await request.get(
      "/api/v1/vaults?sort=state:asc,total_assets:desc,created_at:asc",
    );

    expect(res.status).toBe(200);
  });

  it("returns 400 for more than three sort fields", async () => {
    const res = await request.get(
      "/api/v1/vaults?sort=state:asc,total_assets:desc,created_at:asc,name:asc",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(JSON.stringify(res.body.issues)).toContain("at most 3 fields");
    expect(mocks.listVaults).not.toHaveBeenCalled();
  });

  it("returns 400 for a sort field outside the allowlist", async () => {
    const res = await request.get("/api/v1/vaults?sort=not_a_column:asc");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("Unknown sort field");
    expect(mocks.listVaults).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid sort direction", async () => {
    const res = await request.get("/api/v1/vaults?sort=state:upwards");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("Invalid sort direction");
  });

  it("returns 400 for a duplicated sort field", async () => {
    const res = await request.get("/api/v1/vaults?sort=state:asc,state:desc");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("Duplicate sort field");
  });

  it("keeps the legacy single-field sort and order pair working", async () => {
    const res = await request.get("/api/v1/vaults?sort=total_assets&order=asc");

    expect(res.status).toBe(200);
    expect(forwardedOptions()).toMatchObject({ sort: "total_assets", order: "asc" });
  });

  it("defaults to created_at desc when sort is omitted", async () => {
    const res = await request.get("/api/v1/vaults");

    expect(res.status).toBe(200);
    expect(forwardedOptions()).toMatchObject({ sort: "created_at", order: "desc" });
  });
});

describe("GET /api/v1/vaults creation date range validation (#856)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listVaults.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
  });

  it("accepts a calendar date range and forwards both bounds", async () => {
    const res = await request.get(
      "/api/v1/vaults?createdFrom=2025-01-01&createdTo=2025-06-30",
    );

    expect(res.status).toBe(200);
    expect(forwardedOptions()).toMatchObject({
      createdFrom: "2025-01-01",
      createdTo: "2025-06-30",
    });
  });

  it("accepts a full ISO date-time range", async () => {
    const res = await request.get(
      "/api/v1/vaults?createdFrom=2025-01-01T00:00:00Z&createdTo=2025-06-30T23:59:59Z",
    );

    expect(res.status).toBe(200);
  });

  it("accepts createdFrom on its own as an open-ended filter", async () => {
    const res = await request.get("/api/v1/vaults?createdFrom=2025-01-01");

    expect(res.status).toBe(200);
    expect(forwardedOptions().createdFrom).toBe("2025-01-01");
    expect(forwardedOptions().createdTo).toBeUndefined();
  });

  it("accepts createdTo on its own as an open-ended filter", async () => {
    const res = await request.get("/api/v1/vaults?createdTo=2025-06-30");

    expect(res.status).toBe(200);
    expect(forwardedOptions().createdTo).toBe("2025-06-30");
    expect(forwardedOptions().createdFrom).toBeUndefined();
  });

  it("returns 400 for a malformed date", async () => {
    const res = await request.get("/api/v1/vaults?createdFrom=not-a-date");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(mocks.listVaults).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-ISO date layout", async () => {
    const res = await request.get("/api/v1/vaults?createdFrom=01/02/2025");

    expect(res.status).toBe(400);
  });

  it("returns 400 for an ISO-shaped but impossible date", async () => {
    const res = await request.get("/api/v1/vaults?createdTo=2025-02-30");

    expect(res.status).toBe(400);
  });

  it("returns 400 when createdFrom is after createdTo", async () => {
    const res = await request.get(
      "/api/v1/vaults?createdFrom=2025-06-30&createdTo=2025-01-01",
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("must not be after");
  });

  it("allows createdFrom equal to createdTo", async () => {
    const res = await request.get(
      "/api/v1/vaults?createdFrom=2025-01-01&createdTo=2025-01-01",
    );

    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/vaults total assets range validation (#857)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listVaults.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
  });

  it("accepts a TVL range and forwards both bounds as strings", async () => {
    const res = await request.get(
      "/api/v1/vaults?minTotalAssets=1000000&maxTotalAssets=5000000",
    );

    expect(res.status).toBe(200);
    expect(forwardedOptions()).toMatchObject({
      minTotalAssets: "1000000",
      maxTotalAssets: "5000000",
    });
  });

  it("accepts minTotalAssets on its own as an open-ended filter", async () => {
    const res = await request.get("/api/v1/vaults?minTotalAssets=1000000");

    expect(res.status).toBe(200);
    expect(forwardedOptions().maxTotalAssets).toBeUndefined();
  });

  it("accepts a bound beyond Number.MAX_SAFE_INTEGER without losing precision", async () => {
    const huge = "170141183460469231731687303715884105727";
    const res = await request.get(`/api/v1/vaults?maxTotalAssets=${huge}`);

    expect(res.status).toBe(200);
    expect(forwardedOptions().maxTotalAssets).toBe(huge);
  });

  it("accepts zero as a lower bound", async () => {
    const res = await request.get("/api/v1/vaults?minTotalAssets=0");

    expect(res.status).toBe(200);
    expect(forwardedOptions().minTotalAssets).toBe("0");
  });

  it("returns 400 for a non-numeric value", async () => {
    const res = await request.get("/api/v1/vaults?minTotalAssets=abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(mocks.listVaults).not.toHaveBeenCalled();
  });

  it("returns 400 for a negative value", async () => {
    const res = await request.get("/api/v1/vaults?minTotalAssets=-1");

    expect(res.status).toBe(400);
  });

  it("returns 400 for a fractional value", async () => {
    const res = await request.get("/api/v1/vaults?maxTotalAssets=1000.5");

    expect(res.status).toBe(400);
  });

  it("returns 400 when minTotalAssets exceeds maxTotalAssets", async () => {
    const res = await request.get(
      "/api/v1/vaults?minTotalAssets=5000000&maxTotalAssets=1000000",
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("must not be greater than");
  });

  it("compares the bounds numerically, not lexicographically", async () => {
    // "9" > "10" as strings, but 9 < 10 as numbers, so this must be accepted.
    const res = await request.get("/api/v1/vaults?minTotalAssets=9&maxTotalAssets=10");

    expect(res.status).toBe(200);
  });
});
