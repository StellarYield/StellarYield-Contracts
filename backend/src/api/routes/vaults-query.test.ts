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
