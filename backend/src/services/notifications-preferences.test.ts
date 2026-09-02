import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationService } from "./notifications.js";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./jobQueue.js", () => ({
  jobQueue: { send: vi.fn().mockResolvedValue("job-1"), start: vi.fn(), stop: vi.fn() },
}));

import { query } from "../db/index.js";
import { jobQueue } from "./jobQueue.js";

const mockQuery = query as ReturnType<typeof vi.fn>;
const mockSend = jobQueue.send as ReturnType<typeof vi.fn>;

const WEBHOOK = {
  id: 1,
  url: "https://example.com/hook",
  events: ["deposit"],
  secret: null,
  consecutive_failures: 0,
  channel: "webhook",
  priority: 0,
  fallback_channel: null,
};

describe("NotificationService.notify — per-user preferences (#990)", () => {
  let svc: NotificationService;

  beforeEach(() => {
    svc = new NotificationService();
    vi.clearAllMocks();
  });

  it("skips delivery when the receiver opted out of the event/channel", async () => {
    mockQuery
      .mockResolvedValueOnce([WEBHOOK]) // active webhooks
      .mockResolvedValueOnce([{ enabled: false }]); // preference lookup

    await svc.notify("user.deposit", { contractId: "CVAULT", receiver: "GRECEIVER" });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("delivers when the receiver has no preference row (default enabled)", async () => {
    mockQuery
      .mockResolvedValueOnce([WEBHOOK]) // active webhooks
      .mockResolvedValueOnce([]); // no preference row

    await svc.notify("user.deposit", { contractId: "CVAULT", receiver: "GRECEIVER" });

    expect(mockSend).toHaveBeenCalledWith(
      "webhook-deliver",
      expect.objectContaining({ webhookId: 1 }),
    );
  });

  it("does not filter broadcast events lacking a subject address", async () => {
    mockQuery.mockResolvedValueOnce([WEBHOOK]);

    await svc.notify("yield_distributed", { contractId: "CVAULT", amount: "100" });

    expect(mockQuery).toHaveBeenCalledTimes(1); // no preference lookup
    expect(mockSend).toHaveBeenCalled();
  });
});
