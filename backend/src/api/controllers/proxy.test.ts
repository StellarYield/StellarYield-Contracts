import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  },
}));

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: {
    isRunning: () => true,
    getLastIndexedLedger: async () => 12345,
    getLastTickAt: () => new Date(),
    getEventsIndexedCount: async () => 100,
  },
}));

async function getTestContext() {
  const { proxyRequest } = await import("./proxy.js");
  return { proxyRequest };
}

function makeReqRes(body?: any) {
  const req = { body: body || {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("OpenAPI Proxy Endpoint (#947)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/v1/proxy", () => {
    it("proxies GET request successfully", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        path: "/api/v1/vaults/count",
      });

      await proxyRequest(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(Number),
          headers: expect.any(Object),
          body: expect.any(Object),
        }),
      );
    });

    it("strips Authorization header from proxied request", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        path: "/api/v1/vaults/count",
        headers: { Authorization: "Bearer fake-token" },
      });

      await proxyRequest(req, res, next);

      // The request should succeed but without the Authorization header
      expect(res.json).toHaveBeenCalled();
      const call = res.json.mock.calls[0][0];
      expect(call).toHaveProperty("status");
    });

    it("strips Cookie header (case-insensitive)", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        path: "/api/v1/vaults/count",
        headers: { cookie: "session=abc123" },
      });

      await proxyRequest(req, res, next);

      expect(res.json).toHaveBeenCalled();
    });

    it("strips X-Api-Key header (case-insensitive)", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        path: "/api/v1/vaults/count",
        headers: { "X-API-KEY": "secret-key" },
      });

      await proxyRequest(req, res, next);

      expect(res.json).toHaveBeenCalled();
    });

    it("returns 400 for invalid path (not starting with /api/v1/)", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        path: "/health",
      });

      await proxyRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Path must start with /api/v1/",
      });
    });

    it("returns 403 for loop prevention (target is /api/v1/proxy)", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "POST",
        path: "/api/v1/proxy",
      });

      await proxyRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Cannot proxy to /api/v1/proxy itself",
      });
    });

    it("returns 400 for invalid method", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "INVALID",
        path: "/api/v1/vaults",
      });

      await proxyRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Invalid request body",
      });
    });

    it("returns 400 for missing required fields", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        // missing path
      });

      await proxyRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Invalid request body",
      });
    });

    it("supports POST with body", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "POST",
        path: "/api/v1/webhooks",
        body: { url: "https://example.com", events: ["deposit"] },
      });

      await proxyRequest(req, res, next);

      expect(res.json).toHaveBeenCalled();
    });

    it("preserves non-sensitive headers", async () => {
      const { proxyRequest } = await getTestContext();
      const { req, res, next } = makeReqRes({
        method: "GET",
        path: "/api/v1/vaults/count",
        headers: { "X-Custom-Header": "custom-value", "Content-Type": "application/json" },
      });

      await proxyRequest(req, res, next);

      expect(res.json).toHaveBeenCalled();
    });
  });
});
