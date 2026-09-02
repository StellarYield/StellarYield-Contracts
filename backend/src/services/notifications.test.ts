import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("./jobQueue.js", () => ({
  jobQueue: { send: vi.fn().mockResolvedValue("job-1"), start: vi.fn(), stop: vi.fn() },
}));

async function getTestContext() {
  const { query } = await import("../db/index.js");
  const { jobQueue } = await import("./jobQueue.js");
  const { NotificationService } = await import("./notifications.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    jobQueue: jobQueue as unknown as { send: ReturnType<typeof vi.fn> },
    service: new NotificationService(),
  };
}

describe("NotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("notify", () => {
    it("does nothing when no webhooks match the event", async () => {
      const { query, jobQueue, service } = await getTestContext();
      // First call is the global opt-out check (empty rows = enabled/default),
      // second is the webhook lookup.
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await service.notify("deposit", { amount: "100" });

      expect(jobQueue.send).not.toHaveBeenCalled();
    });

    it("enqueues a webhook-deliver job for each matching webhook", async () => {
      const { query, jobQueue, service } = await getTestContext();
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 1, url: "https://example.com/hook", events: ["deposit"], secret: null },
      ]);

      await service.notify("deposit", { amount: "100" });

      expect(jobQueue.send).toHaveBeenCalledOnce();
      expect(jobQueue.send).toHaveBeenCalledWith("webhook-deliver", {
        webhookId: 1,
        payload: expect.stringContaining('"event":"deposit"'),
      });
    });

    it("enqueues jobs for multiple webhooks", async () => {
      const { query, jobQueue, service } = await getTestContext();
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 1, url: "https://a.com/hook", events: ["deposit"], secret: null },
        { id: 2, url: "https://b.com/hook", events: ["deposit"], secret: "secret" },
      ]);

      await service.notify("deposit", {});

      expect(jobQueue.send).toHaveBeenCalledTimes(2);
      expect(jobQueue.send).toHaveBeenCalledWith("webhook-deliver", {
        webhookId: 1,
        payload: expect.any(String),
      });
      expect(jobQueue.send).toHaveBeenCalledWith("webhook-deliver", {
        webhookId: 2,
        payload: expect.any(String),
      });
    });

    it("constructs a JSON payload with event, data, and timestamp", async () => {
      const { query, jobQueue, service } = await getTestContext();
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 1, url: "https://example.com/hook", events: ["deposit"], secret: null },
      ]);

      await service.notify("deposit", { amount: "100" });

      const payload = jobQueue.send.mock.calls[0][1].payload;
      const parsed = JSON.parse(payload);
      expect(parsed.event).toBe("deposit");
      expect(parsed.data).toEqual({ amount: "100" });
      expect(parsed).toHaveProperty("timestamp");
    });

    it("skips dispatch entirely when globally disabled (#994)", async () => {
      const { query, jobQueue, service } = await getTestContext();
      query.mockResolvedValueOnce([{ value: "false" }]);

      await service.notify("deposit", { amount: "100" });

      expect(jobQueue.send).not.toHaveBeenCalled();
      // Only the opt-out check ran — the webhook lookup was never reached.
      expect(query).toHaveBeenCalledOnce();
    });
  });

  describe("global opt-out (#994)", () => {
    it("isGloballyEnabled defaults to true when the key has never been set", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      await expect(service.isGloballyEnabled()).resolves.toBe(true);
    });

    it("isGloballyEnabled reflects a stored false value", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([{ value: "false" }]);

      await expect(service.isGloballyEnabled()).resolves.toBe(false);
    });

    it("setGloballyEnabled upserts the flag into app_config", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      await service.setGloballyEnabled(false);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO app_config"),
        ["notificationsGloballyEnabled", "false"],
      );
    });
  });

  describe("registerWebhook", () => {
    it("inserts a webhook row into the database", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      await service.registerWebhook("https://example.com/hook", ["deposit"], "secret123");

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO webhooks"),
        ["https://example.com/hook", ["deposit"], "secret123"],
      );
    });

    it("uses null when no secret is provided", async () => {
      const { query, service } = await getTestContext();
      query.mockResolvedValue([]);

      await service.registerWebhook("https://example.com/hook", ["vault_created"]);

      expect(query).toHaveBeenCalledWith(
        expect.any(String),
        ["https://example.com/hook", ["vault_created"], null],
      );
    });
  });
});
