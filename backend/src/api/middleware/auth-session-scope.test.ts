import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-value-for-sessions";

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { requireApiKey, createAdminSessionToken } = await import("./auth.js");
  return { query: query as ReturnType<typeof vi.fn>, requireApiKey, createAdminSessionToken };
}

function makeReqRes(token: string, method: string) {
  const req = {
    headers: { authorization: `Bearer ${token}` },
    method,
    path: "/api/v1/admin/stats",
  } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  return { req, res, next: vi.fn() };
}

// An admin session is minted from an API key, so trading a method-scoped key
// for a session must not widen what that credential can do (#935).
describe("admin session method scope (#935)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a method the minting key was not scoped for", async () => {
    const { requireApiKey, createAdminSessionToken } = await getTestContext();
    const token = createAdminSessionToken({
      id: 7,
      role: "admin",
      label: "read-only-admin",
      allowedMethods: ["GET", "HEAD"],
    });
    const { req, res, next } = makeReqRes(token, "DELETE");

    await requireApiKey()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forbidden",
      message: "API key is not permitted to use the DELETE method",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a method the minting key was scoped for", async () => {
    const { requireApiKey, createAdminSessionToken } = await getTestContext();
    const token = createAdminSessionToken({
      id: 7,
      role: "admin",
      label: "read-only-admin",
      allowedMethods: ["GET", "HEAD"],
    });
    const { req, res, next } = makeReqRes(token, "GET");

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("leaves an unscoped key unrestricted", async () => {
    const { requireApiKey, createAdminSessionToken } = await getTestContext();
    const token = createAdminSessionToken({
      id: 8,
      role: "admin",
      label: "full-admin",
      allowedMethods: null,
    });
    const { req, res, next } = makeReqRes(token, "DELETE");

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
