import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../services/notifications.js", () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
  NotificationService: vi.fn().mockImplementation(() => ({})),
}));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { createWebhook, listWebhooks, deleteWebhook } = await import("./webhooks.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    createWebhook,
    listWebhooks,
    deleteWebhook,
  };
}

describe("Webhook Controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createWebhook", () => {
    it("inserts a webhook and returns 201 without secret", async () => {
      const { query, createWebhook } = await getTestContext();
      const row = {
        id: 1,
        url: "https://example.com/hook",
        events: ["deposit"],
        active: true,
        created_at: new Date("2024-01-01T00:00:00Z"),
      };
      query.mockResolvedValue([row]);

      const req = { body: { url: "https://example.com/hook", events: ["deposit"] } } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const next = vi.fn();

      await createWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        id: 1,
        url: "https://example.com/hook",
        events: ["deposit"],
        active: true,
        consecutiveFailures: 0,
        createdAt: row.created_at,
      });
    });

    it("passes secret as null when not provided", async () => {
      const { query, createWebhook } = await getTestContext();
      query.mockResolvedValue([
        { id: 2, url: "https://example.com/hook", events: ["deposit"], active: true, created_at: new Date() },
      ]);

      const req = { body: { url: "https://example.com/hook", events: ["deposit"] } } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const next = vi.fn();

      await createWebhook(req, res, next);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO webhooks"),
        ["https://example.com/hook", ["deposit"], null],
      );
    });

    it("calls next on db error", async () => {
      const { query, createWebhook } = await getTestContext();
      const err = new Error("db error");
      query.mockRejectedValue(err);

      const req = { body: { url: "https://example.com/hook", events: ["deposit"] } } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const next = vi.fn();

      await createWebhook(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe("listWebhooks", () => {
    it("returns active webhooks without secret field", async () => {
      const { query, listWebhooks } = await getTestContext();
      query.mockResolvedValue([
        { id: 1, url: "https://a.com/hook", events: ["deposit"], active: true, created_at: new Date() },
        { id: 2, url: "https://b.com/hook", events: ["vault_created"], active: true, created_at: new Date() },
      ]);

      const req = {} as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await listWebhooks(req, res, next);

      const result = res.json.mock.calls[0][0];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      result.forEach((w: any) => {
        expect(w).not.toHaveProperty("secret");
      });
    });

    it("returns empty array when no webhooks", async () => {
      const { query, listWebhooks } = await getTestContext();
      query.mockResolvedValue([]);

      const req = {} as any;
      const res = { json: vi.fn() } as any;
      const next = vi.fn();

      await listWebhooks(req, res, next);

      expect(res.json).toHaveBeenCalledWith([]);
    });
  });

  describe("deleteWebhook", () => {
    it("returns 204 when webhook is soft-deleted", async () => {
      const { query, deleteWebhook } = await getTestContext();
      query.mockResolvedValue([{ id: 1 }]);

      const req = { params: { id: "1" } } as any;
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() } as any;
      const next = vi.fn();

      await deleteWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it("returns 404 when webhook is not found", async () => {
      const { query, deleteWebhook } = await getTestContext();
      query.mockResolvedValue([]);

      const req = { params: { id: "999" } } as any;
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() } as any;
      const next = vi.fn();

      await deleteWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "NotFound", message: "Webhook not found" });
    });

    it("uses soft delete (sets active=FALSE)", async () => {
      const { query, deleteWebhook } = await getTestContext();
      query.mockResolvedValue([{ id: 5 }]);

      const req = { params: { id: "5" } } as any;
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() } as any;
      const next = vi.fn();

      await deleteWebhook(req, res, next);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("active = FALSE"),
        [5],
      );
    });
  });
});
