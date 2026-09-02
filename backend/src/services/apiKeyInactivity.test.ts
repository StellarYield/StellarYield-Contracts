import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../config.js", () => ({ config: { apiKeyInactivityDays: null as number | null } }));
vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function getTestContext() {
  const { query } = await import("../db/index.js");
  const { config } = await import("../config.js");
  const { deactivateInactiveApiKeys } = await import("./apiKeyInactivity.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    config: config as { apiKeyInactivityDays: number | null },
    deactivateInactiveApiKeys,
  };
}

describe("deactivateInactiveApiKeys (#934)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { config } = await getTestContext();
    config.apiKeyInactivityDays = null;
  });

  it("does nothing when KEY_INACTIVITY_DAYS is unset", async () => {
    const { query, deactivateInactiveApiKeys } = await getTestContext();

    const deactivated = await deactivateInactiveApiKeys();

    expect(deactivated).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("deactivates keys idle for longer than the threshold", async () => {
    const { query, config, deactivateInactiveApiKeys } = await getTestContext();
    config.apiKeyInactivityDays = 90;
    query.mockResolvedValue([
      {
        id: 4,
        label: "stale-integration",
        last_used_at: new Date("2026-01-01T00:00:00Z"),
        created_at: new Date("2025-12-01T00:00:00Z"),
      },
    ]);

    const deactivated = await deactivateInactiveApiKeys();

    expect(deactivated).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("SET active = FALSE");
    expect(String(sql)).toContain("deactivated_at = NOW()");
    // The threshold is bound as a parameter rather than interpolated into SQL.
    expect(String(sql)).toContain("make_interval(days => $1::int)");
    expect(params).toEqual([90]);
  });

  it("measures never-used keys from created_at", async () => {
    const { query, config, deactivateInactiveApiKeys } = await getTestContext();
    config.apiKeyInactivityDays = 30;
    query.mockResolvedValue([
      { id: 9, label: "never-used", last_used_at: null, created_at: new Date("2026-01-01T00:00:00Z") },
    ]);

    const deactivated = await deactivateInactiveApiKeys();

    expect(deactivated).toBe(1);
    expect(String(query.mock.calls[0][0])).toContain("COALESCE(last_used_at, created_at)");
  });

  it("only considers keys that are still active, so repeat runs are no-ops", async () => {
    const { query, config, deactivateInactiveApiKeys } = await getTestContext();
    config.apiKeyInactivityDays = 30;
    query.mockResolvedValue([]);

    const deactivated = await deactivateInactiveApiKeys();

    expect(deactivated).toBe(0);
    expect(String(query.mock.calls[0][0])).toContain("WHERE active");
  });
});
