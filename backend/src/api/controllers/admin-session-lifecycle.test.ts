import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../db/index.js", () => ({ query: vi.fn(), pool: {} }));

process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-value-for-sessions";

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { createAdminSession } = await import("./admin.js");
  return { query: query as ReturnType<typeof vi.fn>, createAdminSession };
}

function makeReqRes() {
  const req = { body: { apiKey: "some-admin-key" } } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
  return { req, res, next: vi.fn() };
}

// A session must never be a way around the lifecycle checks the auth
// middleware applies to the key itself (#933, #934).
describe("POST /api/v1/admin/session key lifecycle (#934)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to mint a session for a deactivated key", async () => {
    const { query, createAdminSession } = await getTestContext();
    query.mockResolvedValueOnce([
      {
        id: 1,
        role: "admin",
        label: "stale",
        expires_at: null,
        active: false,
        allowed_methods: null,
      },
    ]);
    const { req, res, next } = makeReqRes();

    await createAdminSession(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forbidden",
      message: "API key has been deactivated",
    });
  });

  it("stamps last_used_at when a session is minted", async () => {
    const { query, createAdminSession } = await getTestContext();
    query.mockResolvedValueOnce([
      {
        id: 42,
        role: "admin",
        label: "live",
        expires_at: null,
        active: true,
        allowed_methods: null,
      },
    ]);
    query.mockResolvedValueOnce([]);
    const { req, res, next } = makeReqRes();

    await createAdminSession(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [
      42,
    ]);
  });
});
