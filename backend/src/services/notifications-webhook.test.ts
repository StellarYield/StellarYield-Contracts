import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { NotificationService } from "./notifications.js";

vi.mock("../db/index.js", () => ({
  query: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./jobQueue.js", () => ({
  jobQueue: { send: vi.fn().mockResolvedValue("job-1"), start: vi.fn(), stop: vi.fn() },
}));

import { query } from "../db/index.js";

const mockQuery = query as ReturnType<typeof vi.fn>;

describe("NotificationService.verifySignature (#664)", () => {
  const svc = new NotificationService();

  it("returns true for a correctly signed payload", async () => {
    const secret = "my-secret";
    const payload = '{"event":"test"}';
    // Compute expected signature manually
    const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect(svc.verifySignature(payload, expected, secret)).toBe(true);
  });

  it("returns false for a tampered payload", async () => {
    const secret = "my-secret";
    const originalPayload = '{"event":"test"}';
    const tamperedPayload = '{"event":"tampered"}';
    const sig = `sha256=${createHmac("sha256", secret).update(originalPayload).digest("hex")}`;
    expect(svc.verifySignature(tamperedPayload, sig, secret)).toBe(false);
  });

  it("returns false for a wrong secret", async () => {
    const payload = '{"event":"test"}';
    const sig = `sha256=${createHmac("sha256", "correct-secret").update(payload).digest("hex")}`;
    expect(svc.verifySignature(payload, sig, "wrong-secret")).toBe(false);
  });

  it("returns false when signature length differs", () => {
    expect(svc.verifySignature("payload", "short", "secret")).toBe(false);
  });
});

describe("NotificationService.notify — enqueues via job queue (#847)", () => {
  let svc: NotificationService;

  beforeEach(() => {
    svc = new NotificationService();
    mockQuery.mockReset();
    vi.clearAllMocks();
  });

  it("enqueues a job for each matching webhook", async () => {
    // First call is the global opt-out check (empty rows = enabled/default),
    // second is the webhook lookup.
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 1, url: "https://example.com/hook", events: ["deposit"], secret: null },
    ]);

    const { jobQueue } = await import("./jobQueue.js");
    const mockSend = jobQueue.send as ReturnType<typeof vi.fn>;
    mockSend.mockResolvedValue("job-1");

    await svc.notify("deposit", { amount: 100 });

    expect(mockSend).toHaveBeenCalledWith("webhook-deliver", {
      webhookId: 1,
      payload: expect.stringContaining('"event":"deposit"'),
    });
  });

  it("does nothing when no webhooks match", async () => {
    mockQuery.mockResolvedValue([]);

    const { jobQueue } = await import("./jobQueue.js");
    const mockSend = jobQueue.send as ReturnType<typeof vi.fn>;

    await svc.notify("deposit", {});

    expect(mockSend).not.toHaveBeenCalled();
  });
});
