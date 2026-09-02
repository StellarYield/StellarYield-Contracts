import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));

import {
  getNotificationPreferences,
  updateNotificationPreferences,
  createVaultSubscription,
  deleteVaultSubscription,
  listVaultSubscriptions,
} from "./userNotifications.js";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const VAULT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPJL";

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET notification preferences (#989)", () => {
  it("returns all preference rows for the user", async () => {
    mocks.query.mockResolvedValueOnce([
      {
        event_type: "deposit",
        channel: "webhook",
        enabled: false,
        vault_contract_id: null,
        updated_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const res = mockRes();
    await getNotificationPreferences({ params: { address: ADDRESS } } as any, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      preferences: [
        {
          eventType: "deposit",
          channel: "webhook",
          enabled: false,
          vaultContractId: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });
});

describe("PUT notification preferences (#989)", () => {
  it("upserts a preference and returns the refreshed list", async () => {
    mocks.query
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([
        {
          event_type: "deposit",
          channel: "webhook",
          enabled: false,
          vault_contract_id: null,
          updated_at: new Date("2026-01-02T00:00:00Z"),
        },
      ]);
    const res = mockRes();
    await updateNotificationPreferences(
      { params: { address: ADDRESS }, body: [{ eventType: "deposit", channel: "webhook", enabled: false }] } as any,
      res,
      vi.fn(),
    );

    const upsertCall = mocks.query.mock.calls[0];
    expect(upsertCall[0]).toContain("INSERT INTO user_notification_preferences");
    expect(upsertCall[1]).toEqual([ADDRESS, "deposit", "webhook", false, null]);
    expect(res.json).toHaveBeenCalledWith({
      preferences: [
        expect.objectContaining({ eventType: "deposit", channel: "webhook", enabled: false }),
      ],
    });
  });

  it("rejects an unknown event type with HTTP 400", async () => {
    const res = mockRes();
    await updateNotificationPreferences(
      { params: { address: ADDRESS }, body: [{ eventType: "not_a_real_event", channel: "webhook", enabled: true }] } as any,
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "UnknownEventType" }));
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a non-array body with HTTP 400", async () => {
    const res = mockRes();
    await updateNotificationPreferences(
      { params: { address: ADDRESS }, body: { eventType: "deposit" } } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("per-vault subscriptions (#991)", () => {
  it("POST subscribes the user to the given events for a vault", async () => {
    mocks.query.mockResolvedValue([]);
    const res = mockRes();
    await createVaultSubscription(
      { params: { address: ADDRESS }, body: { contractId: VAULT, events: ["deposit", "withdraw"] } } as any,
      res,
      vi.fn(),
    );

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][1]).toEqual([ADDRESS, "deposit", "webhook", true, VAULT]);
    expect(mocks.query.mock.calls[1][1]).toEqual([ADDRESS, "withdraw", "webhook", true, VAULT]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("DELETE removes every subscription for that vault", async () => {
    mocks.query.mockResolvedValue([]);
    const res = mockRes();
    await deleteVaultSubscription(
      { params: { address: ADDRESS, contractId: VAULT } } as any,
      res,
      vi.fn(),
    );

    expect(mocks.query.mock.calls[0][0]).toContain("DELETE FROM user_notification_preferences");
    expect(mocks.query.mock.calls[0][1]).toEqual([ADDRESS, VAULT]);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("GET lists active subscriptions grouped by vault", async () => {
    mocks.query.mockResolvedValueOnce([
      { vault_contract_id: VAULT, event_type: "deposit" },
      { vault_contract_id: VAULT, event_type: "withdraw" },
    ]);
    const res = mockRes();
    await listVaultSubscriptions({ params: { address: ADDRESS } } as any, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      subscriptions: [{ contractId: VAULT, events: ["deposit", "withdraw"] }],
    });
  });
});
