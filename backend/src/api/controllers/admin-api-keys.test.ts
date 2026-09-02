import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { getApiKeys } = await import("./admin.js");
  return { query: query as ReturnType<typeof vi.fn>, getApiKeys };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
}

describe("GET /api/v1/admin/api-keys key metadata (#933)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns lastUsedAt for a key that has been used", async () => {
    const { query, getApiKeys } = await getTestContext();
    const lastUsedAt = new Date("2026-08-20T10:00:00Z");
    query.mockResolvedValue([
      {
        id: 1,
        label: "ci-bot",
        role: "admin",
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: null,
        last_used_at: lastUsedAt,
      },
    ]);
    const res = makeRes();

    await getApiKeys({} as any, res, vi.fn());

    expect(String(query.mock.calls[0][0])).toContain("last_used_at");
    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 1, lastUsedAt })]);
  });

  it("returns lastUsedAt as null for a key that has never been used", async () => {
    const { query, getApiKeys } = await getTestContext();
    query.mockResolvedValue([
      {
        id: 2,
        label: "unused",
        role: "readonly",
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: null,
        last_used_at: null,
      },
    ]);
    const res = makeRes();

    await getApiKeys({} as any, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 2, lastUsedAt: null })]);
  });
});
