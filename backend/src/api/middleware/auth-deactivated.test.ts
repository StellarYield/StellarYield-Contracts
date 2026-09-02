import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { requireApiKey } = await import("./auth.js");
  return { query: query as ReturnType<typeof vi.fn>, requireApiKey };
}

function makeReqRes(method = "GET") {
  const req = { headers: { authorization: "Bearer some-key" }, method, path: "/api/v1/admin/stats" } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  return { req, res, next: vi.fn() };
}

describe("requireApiKey deactivated keys (#934)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for a key that has been deactivated", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([
      { id: 1, role: "admin", label: "stale", expiresAt: null, lastUsedAt: null, active: false },
    ]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forbidden",
      message: "API key has been deactivated",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("does not stamp last_used_at for a deactivated key", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([
      { id: 1, role: "admin", label: "stale", expiresAt: null, lastUsedAt: null, active: false },
    ]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    const updates = query.mock.calls.filter(([sql]) => String(sql).includes("SET last_used_at"));
    expect(updates).toHaveLength(0);
  });

  it("allows an active key through", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([
      { id: 2, role: "admin", label: "live", expiresAt: null, lastUsedAt: null, active: true },
    ]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("selects the active flag alongside the key row", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([
      { id: 2, role: "admin", label: "live", expiresAt: null, lastUsedAt: null, active: true },
    ]);
    const { req, res, next } = makeReqRes();

    await requireApiKey()(req, res, next);

    expect(String(query.mock.calls[0][0])).toContain("active");
  });
});
