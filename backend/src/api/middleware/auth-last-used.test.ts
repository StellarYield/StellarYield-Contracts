import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database layer so the middleware never touches a real DB.
vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { requireApiKey } = await import("./auth.js");
  return { query: query as ReturnType<typeof vi.fn>, requireApiKey };
}

function makeReqRes(method = "GET") {
  const req = { headers: { authorization: "Bearer some-key" }, method, path: "/api/v1/admin/stats" } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

/** Calls made against api_keys that write the last-used timestamp. */
function lastUsedUpdates(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.filter(([sql]) => String(sql).includes("SET last_used_at = NOW()"));
}

describe("requireApiKey last-used tracking (#933)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps last_used_at after a successful authentication", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValueOnce([{ id: 7, role: "admin", label: "ci-bot", expiresAt: null, lastUsedAt: null }]);
    query.mockResolvedValueOnce([]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const updates = lastUsedUpdates(query);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([7]);
  });

  it("selects last_used_at so the value is available on req.apiKey", async () => {
    const { query, requireApiKey } = await getTestContext();
    const lastUsedAt = new Date("2026-08-01T00:00:00Z");
    query.mockResolvedValueOnce([{ id: 3, role: "readonly", label: null, expiresAt: null, lastUsedAt }]);
    query.mockResolvedValueOnce([]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(String(query.mock.calls[0][0])).toContain('last_used_at AS "lastUsedAt"');
    expect(req.apiKey.lastUsedAt).toEqual(lastUsedAt);
  });

  it("does not stamp last_used_at when authentication fails", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(lastUsedUpdates(query)).toHaveLength(0);
  });

  it("does not stamp last_used_at when the key is expired", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([
      { id: 1, role: "admin", label: "old", expiresAt: new Date(Date.now() - 1000), lastUsedAt: null },
    ]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(lastUsedUpdates(query)).toHaveLength(0);
  });

  it("stamps only once when the guard runs twice in the same request", async () => {
    const { query, requireApiKey } = await getTestContext();
    const row = { id: 7, role: "admin", label: "ci-bot", expiresAt: null, lastUsedAt: null };
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("SELECT") ? [row] : [],
    );
    const { req, res, next } = makeReqRes();

    // Mirrors the admin router: a router-level guard plus a per-route role check.
    await requireApiKey({ minRole: "readonly" })(req, res, next);
    await requireApiKey({ role: "admin" })(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(lastUsedUpdates(query)).toHaveLength(1);
  });

  it("still authenticates the request when the timestamp write fails", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET last_used_at")) throw new Error("write failed");
      return [{ id: 5, role: "admin", label: "ci-bot", expiresAt: null, lastUsedAt: null }];
    });
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
