import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  },
}));
vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: {
    isRunning: () => false,
    getLastIndexedLedger: async () => 0,
    getLastTickAt: () => null,
    getEventsIndexedCount: async () => 0,
  },
}));
vi.mock("../../services/jobQueue.js", () => ({
  jobQueue: {
    send: vi.fn(),
    getJob: vi.fn(),
    getFailedJobs: vi.fn(() => []),
  },
}));
vi.mock("../../services/sseManager.js", () => ({
  sseManager: {
    addIndexerClient: vi.fn(),
  },
}));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { getApiKeys, updateApiKeyDescription } = await import("./admin.js");
  return { query: query as ReturnType<typeof vi.fn>, getApiKeys, updateApiKeyDescription };
}

function makeReqRes(params?: any, body?: any) {
  const req = { params: params || {}, body: body || {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("API Key Description (#946)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/v1/admin/api-keys", () => {
    it("includes description field in response", async () => {
      const { query, getApiKeys } = await getTestContext();
      query.mockResolvedValue([
        {
          id: 1,
          label: "test-key",
          role: "admin",
          created_at: new Date("2024-01-01"),
          expires_at: null,
          description: "Test API key description",
        },
      ]);
      const { req, res, next } = makeReqRes();

      await getApiKeys(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith([
        {
          id: 1,
          label: "test-key",
          role: "admin",
          createdAt: new Date("2024-01-01"),
          expiresAt: null,
          description: "Test API key description",
        },
      ]);
    });

    it("includes description as null when not set", async () => {
      const { query, getApiKeys } = await getTestContext();
      query.mockResolvedValue([
        {
          id: 2,
          label: "another-key",
          role: "readonly",
          created_at: new Date("2024-01-02"),
          expires_at: null,
          description: null,
        },
      ]);
      const { req, res, next } = makeReqRes();

      await getApiKeys(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith([
        {
          id: 2,
          label: "another-key",
          role: "readonly",
          createdAt: new Date("2024-01-02"),
          expiresAt: null,
          description: null,
        },
      ]);
    });
  });

  describe("PATCH /api/v1/admin/api-keys/:id/description", () => {
    it("updates description field successfully", async () => {
      const { query, updateApiKeyDescription } = await getTestContext();
      // First call: check if key exists
      query.mockResolvedValueOnce([{ id: 1 }]);
      // Second call: update (no return needed)
      query.mockResolvedValueOnce([]);
      // Third call: fetch updated key
      query.mockResolvedValueOnce([
        {
          id: 1,
          label: "test-key",
          role: "admin",
          created_at: new Date("2024-01-01"),
          expires_at: null,
          description: "Updated description",
        },
      ]);

      const { req, res, next } = makeReqRes(
        { id: "1" },
        { description: "Updated description" },
      );

      await updateApiKeyDescription(req, res, next);

      expect(query).toHaveBeenCalledWith("SELECT id FROM api_keys WHERE id = $1", [1]);
      expect(query).toHaveBeenCalledWith("UPDATE api_keys SET description = $1 WHERE id = $2", [
        "Updated description",
        1,
      ]);
      expect(res.json).toHaveBeenCalledWith({
        id: 1,
        label: "test-key",
        role: "admin",
        createdAt: new Date("2024-01-01"),
        expiresAt: null,
        description: "Updated description",
      });
    });

    it("allows setting description to null", async () => {
      const { query, updateApiKeyDescription } = await getTestContext();
      query.mockResolvedValueOnce([{ id: 1 }]);
      query.mockResolvedValueOnce([]);
      query.mockResolvedValueOnce([
        {
          id: 1,
          label: "test-key",
          role: "admin",
          created_at: new Date("2024-01-01"),
          expires_at: null,
          description: null,
        },
      ]);

      const { req, res, next } = makeReqRes({ id: "1" }, { description: null });

      await updateApiKeyDescription(req, res, next);

      expect(query).toHaveBeenCalledWith("UPDATE api_keys SET description = $1 WHERE id = $2", [
        null,
        1,
      ]);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
      );
    });

    it("returns 404 for nonexistent key", async () => {
      const { query, updateApiKeyDescription } = await getTestContext();
      query.mockResolvedValueOnce([]);

      const { req, res, next } = makeReqRes(
        { id: "999" },
        { description: "New description" },
      );

      await updateApiKeyDescription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "NotFound",
        message: "API key not found",
      });
    });

    it("returns 400 for invalid key ID", async () => {
      const { updateApiKeyDescription } = await getTestContext();
      const { req, res, next } = makeReqRes(
        { id: "invalid" },
        { description: "New description" },
      );

      await updateApiKeyDescription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Invalid key ID",
      });
    });

    it("returns 400 for invalid request body", async () => {
      const { updateApiKeyDescription } = await getTestContext();
      const { req, res, next } = makeReqRes({ id: "1" }, { description: 123 });

      await updateApiKeyDescription(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Invalid request body",
      });
    });
  });
});
