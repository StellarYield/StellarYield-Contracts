import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { requireApiKey } = await import("./auth.js");
  return { query: query as ReturnType<typeof vi.fn>, requireApiKey };
}

function makeReqRes(method: string) {
  const req = { headers: { authorization: "Bearer some-key" }, method, path: "/api/v1/webhooks" } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  return { req, res, next: vi.fn() };
}

function keyRow(allowedMethods: string[] | null) {
  return {
    id: 1,
    role: "admin",
    label: "integration",
    expiresAt: null,
    lastUsedAt: null,
    active: true,
    allowedMethods,
  };
}

describe("requireApiKey HTTP method scope (#935)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a POST request from a GET-only key with 403", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow(["GET"])]);
    const { req, res, next } = makeReqRes("POST");

    await requireApiKey()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forbidden",
      message: "API key is not permitted to use the POST method",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a GET request from a GET-only key", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow(["GET"])]);
    const { req, res, next } = makeReqRes("GET");

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows every method when allowed_methods is null", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow(null)]);

    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
      const { req, res, next } = makeReqRes(method);
      await requireApiKey()(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("honours a multi-method scope such as read-only integrations", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow(["GET", "HEAD", "OPTIONS"])]);

    const head = makeReqRes("HEAD");
    await requireApiKey()(head.req, head.res, head.next);
    expect(head.next).toHaveBeenCalledOnce();

    const del = makeReqRes("DELETE");
    await requireApiKey()(del.req, del.res, del.next);
    expect(del.res.status).toHaveBeenCalledWith(403);
  });

  it("compares methods case-insensitively", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow(["get"])]);
    const { req, res, next } = makeReqRes("get");

    await requireApiKey()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("does not stamp last_used_at when the method is rejected", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow(["GET"])]);
    const { req, res, next } = makeReqRes("DELETE");

    await requireApiKey()(req, res, next);

    const updates = query.mock.calls.filter(([sql]) => String(sql).includes("SET last_used_at"));
    expect(updates).toHaveLength(0);
  });
});
