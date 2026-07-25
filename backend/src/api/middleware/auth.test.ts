import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// Mock the database layer so the middleware never touches a real DB.
vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { requireApiKey } = await import("./auth.js");
  return { query: query as ReturnType<typeof vi.fn>, requireApiKey };
}

function makeReqRes(authHeader?: string) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("requireApiKey middleware (#693)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("missing or malformed Authorization header", () => {
    it("returns 401 Unauthorized when no Authorization header is present", async () => {
      const { query, requireApiKey } = await getTestContext();
      const { req, res, next } = makeReqRes();

      await requireApiKey()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "Missing API key",
      });
      expect(next).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it("returns 401 when the header is missing the 'Bearer ' prefix", async () => {
      const { query, requireApiKey } = await getTestContext();
      const { req, res, next } = makeReqRes("my-secret-key");

      await requireApiKey()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "Missing API key",
      });
      expect(next).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it("returns 401 for a non-Bearer scheme such as Basic auth", async () => {
      const { requireApiKey } = await getTestContext();
      const { req, res, next } = makeReqRes("Basic dXNlcjpwYXNz");

      await requireApiKey()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("invalid API key", () => {
    it("returns 403 Forbidden when the key is not found in the database", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([]);
      const { req, res, next } = makeReqRes("Bearer unknown-key");

      await requireApiKey()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Invalid API key",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("treats a database error as an invalid key (fails closed with 403)", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockRejectedValue(new Error("connection refused"));
      const { req, res, next } = makeReqRes("Bearer some-key");

      await requireApiKey()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Invalid API key",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("role enforcement", () => {
    it("returns 403 when a valid key has a role other than the required one", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 1, role: "user", label: "read-only" }]);
      const { req, res, next } = makeReqRes("Bearer user-key");

      await requireApiKey({ role: "admin" })(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Insufficient permissions",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("calls next() and attaches req.apiKey for a valid admin key", async () => {
      const { query, requireApiKey } = await getTestContext();
      const apiKey = { id: 7, role: "admin", label: "ci-bot" };
      query.mockResolvedValue([apiKey]);
      const { req, res, next } = makeReqRes("Bearer admin-key");

      await requireApiKey({ role: "admin" })(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith();
      expect(req.apiKey).toEqual(apiKey);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("calls next() for any valid key when no role is required", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 9, role: "user", label: null }]);
      const { req, res, next } = makeReqRes("Bearer user-key");

      await requireApiKey()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("minRole: readonly enforcement (#750)", () => {
    it("allows a readonly key to call a GET route", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 1, role: "readonly", label: null }]);
      const { req, res, next } = makeReqRes("Bearer readonly-key");
      req.method = "GET";

      await requireApiKey({ minRole: "readonly" })(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("rejects a readonly key on a POST route with 403", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 1, role: "readonly", label: null }]);
      const { req, res, next } = makeReqRes("Bearer readonly-key");
      req.method = "POST";

      await requireApiKey({ minRole: "readonly" })(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Insufficient permissions",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("allows an admin key to call a POST route under minRole: readonly", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 1, role: "admin", label: null }]);
      const { req, res, next } = makeReqRes("Bearer admin-key");
      req.method = "POST";

      await requireApiKey({ minRole: "readonly" })(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("key expiry (#751)", () => {
    it("returns 401 when the API key has expired", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([
        { id: 1, role: "admin", label: null, expiresAt: new Date(Date.now() - 1000) },
      ]);
      const { req, res, next } = makeReqRes("Bearer expired-key");

      await requireApiKey()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "API key has expired",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("allows a key with a future expiry date", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([
        { id: 1, role: "admin", label: null, expiresAt: new Date(Date.now() + 1000 * 60 * 60) },
      ]);
      const { req, res, next } = makeReqRes("Bearer valid-key");

      await requireApiKey()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("allows a key with no expiry (expiresAt: null)", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 1, role: "admin", label: null, expiresAt: null }]);
      const { req, res, next } = makeReqRes("Bearer valid-key");

      await requireApiKey()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("key hashing", () => {
    it("looks the key up by its SHA-256 hash, never the plaintext", async () => {
      const { query, requireApiKey } = await getTestContext();
      query.mockResolvedValue([{ id: 1, role: "admin", label: null }]);
      const plaintext = "super-secret-token";
      const { req, res, next } = makeReqRes(`Bearer ${plaintext}`);

      await requireApiKey({ role: "admin" })(req, res, next);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("FROM api_keys"),
        [sha256Hex(plaintext)],
      );
      const [, params] = query.mock.calls[0];
      expect(params[0]).not.toBe(plaintext);
    });
  });
});
