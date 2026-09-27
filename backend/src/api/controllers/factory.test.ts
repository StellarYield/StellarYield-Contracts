import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../config.js", () => ({
  config: {
    logLevel: "info",
    nodeEnv: "test",
    adminJwtSecret: "test-secret-at-least-32-chars-long-12345",
    adminSessionExpiryMinutes: 60,
    stellar: { vaultFactoryContractId: "CFACTORY000000000000000000000000000000000000000000000" },
  },
}));


import {
  getFactoryAdminHistory,
  getVaultCreationRate,
  getFactoryDefaults,
  getFactoryEvents,
  getFactoryOperators,
} from "./factory.js";


function makeRes() {
  return {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
}

describe("getFactoryAdminHistory (#839)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns admin transfer history ordered reverse-chronologically", async () => {
    const { query } = await import("../../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { old_admin: "GOLD", new_admin: "GNEW", ledger: 200, recorded_at: new Date("2026-01-02") },
      { old_admin: "GOLDER", new_admin: "GOLD", ledger: 100, recorded_at: new Date("2026-01-01") },
    ]);

    const res = makeRes();
    await getFactoryAdminHistory({} as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith([
      { oldAdmin: "GOLD", newAdmin: "GNEW", ledger: 200, recordedAt: new Date("2026-01-02") },
      { oldAdmin: "GOLDER", newAdmin: "GOLD", ledger: 100, recordedAt: new Date("2026-01-01") },
    ]);
  });

  it("returns an empty array when no transfers have occurred", async () => {
    const { query } = await import("../../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const res = makeRes();
    await getFactoryAdminHistory({} as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith([]);
  });
});

describe("getVaultCreationRate (#840)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns counts for each rolling window", async () => {
    const { query } = await import("../../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { last24h: "2", last7d: "5", last30d: "12" },
    ]);

    const res = makeRes();
    await getVaultCreationRate({} as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith({ last24h: 2, last7d: 5, last30d: 12 });
  });
});

describe("getFactoryDefaults (#841)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the fields from the most recent def_upd event", async () => {
    const { query } = await import("../../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { parsed_data: { asset: "XLM", zkmeVerifier: "GZKME", cooperator: "GCOOP" } },
    ]);

    const res = makeRes();
    await getFactoryDefaults({} as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith({
      defaultAsset: "XLM",
      defaultZkmeVerifier: "GZKME",
      defaultCooperator: "GCOOP",
    });
  });

  it("returns nulls when no def_upd event has been indexed", async () => {
    const { query } = await import("../../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const res = makeRes();
    await getFactoryDefaults({} as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith({
      defaultAsset: null,
      defaultZkmeVerifier: null,
      defaultCooperator: null,
    });
  });
});

describe("getFactoryEvents (#842)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns paginated factory events in reverse ledger order", async () => {
    const { query } = await import("../../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValueOnce([
      { event_type: "v_create", ledger: 300, tx_hash: "tx2", created_at: new Date("2026-01-02") },
      { event_type: "adm_xfr", ledger: 200, tx_hash: "tx1", created_at: new Date("2026-01-01") },
    ]);
    mockQuery.mockResolvedValueOnce([{ count: "2" }]);

    const req = { query: { page: 1, pageSize: 20 } };
    const res = makeRes();
    await getFactoryEvents(req as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith({
      data: [
        { eventType: "v_create", ledger: 300, txHash: "tx2", createdAt: new Date("2026-01-02") },
        { eventType: "adm_xfr", ledger: 200, txHash: "tx1", createdAt: new Date("2026-01-01") },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
  });
});

describe("getFactoryOperators", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active factory-level role holders", async () => {
    const { query } = await import("../../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValueOnce([
      { address: "GOPERATOR1", role: "admin", assigned_at: new Date("2026-01-02") },
      { address: "GOPERATOR2", role: "operator", assigned_at: new Date("2026-01-01") },
    ]);

    const res = makeRes();
    await getFactoryOperators({} as any, res as any, next);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/FROM\s+vault_roles/i),
      ["CFACTORY000000000000000000000000000000000000000000000"],
    );
    expect(res.json).toHaveBeenCalledWith([
      { address: "GOPERATOR1", role: "admin", assignedAt: new Date("2026-01-02") },
      { address: "GOPERATOR2", role: "operator", assignedAt: new Date("2026-01-01") },
    ]);
  });

  it("returns [] if no role events for the factory have been indexed", async () => {
    const { query } = await import("../../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValueOnce([]);

    const res = makeRes();
    await getFactoryOperators({} as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("forwards database errors to next", async () => {
    const { query } = await import("../../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;
    const dbError = new Error("DB error");
    mockQuery.mockRejectedValueOnce(dbError);

    const res = makeRes();
    await getFactoryOperators({} as any, res as any, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

describe("GET /api/v1/factory/operators route protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { factoryRouter } = await import("../routes/factory.js");

    const app = express();
    app.use("/api/v1/factory", factoryRouter);

    const res = await supertest(app).get("/api/v1/factory/operators");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized", message: "Missing API key" });
  });

  it("accepts requests with valid API key and returns factory operators", async () => {
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { factoryRouter } = await import("../routes/factory.js");
    const { query } = await import("../../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;

    // auth middleware looks up key in api_keys:
    mockQuery.mockResolvedValueOnce([
      { id: 1, role: "admin", label: "test-key", active: true, allowedMethods: null },
    ]);
    // touchLastUsed:
    mockQuery.mockResolvedValueOnce([]);
    // getFactoryOperators query for vault_roles:
    mockQuery.mockResolvedValueOnce([
      { address: "GOPERATOR1", role: "operator", assigned_at: new Date("2026-01-01T00:00:00Z") },
    ]);

    const app = express();
    app.use("/api/v1/factory", factoryRouter);

    const res = await supertest(app)
      .get("/api/v1/factory/operators")
      .set("Authorization", "Bearer valid-test-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { address: "GOPERATOR1", role: "operator", assignedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

