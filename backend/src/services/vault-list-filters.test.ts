import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

import { VaultService } from "./vault.js";
import * as db from "../db/index.js";

/** SQL and bound parameters of the vault page query (the first `query` call). */
function listCall(): { sql: string; params: unknown[] } {
  const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
  return { sql, params };
}

/** SQL and bound parameters of the COUNT query (the second `query` call). */
function countCall(): { sql: string; params: unknown[] } {
  const [sql, params] = vi.mocked(db.query).mock.calls[1] as [string, unknown[]];
  return { sql, params };
}

describe("VaultService.listVaults creation date range (#856)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
    vi.mocked(db.query).mockResolvedValue([]);
  });

  it("applies both bounds when a full range is supplied", async () => {
    await service.listVaults({
      page: 1,
      pageSize: 20,
      createdFrom: "2025-01-01",
      createdTo: "2025-06-30",
    });

    const { sql, params } = listCall();
    expect(sql).toContain("v.created_at >= $1::timestamptz");
    expect(sql).toContain("v.created_at <= $2::timestamptz");
    expect(params).toEqual(expect.arrayContaining(["2025-01-01", "2025-06-30"]));
  });

  it("applies an open-ended lower bound when only createdFrom is supplied", async () => {
    await service.listVaults({ page: 1, pageSize: 20, createdFrom: "2025-01-01" });

    const { sql, params } = listCall();
    expect(sql).toContain("v.created_at >= $1::timestamptz");
    expect(sql).not.toContain("v.created_at <=");
    expect(params).toEqual(expect.arrayContaining(["2025-01-01"]));
  });

  it("applies an open-ended upper bound when only createdTo is supplied", async () => {
    await service.listVaults({ page: 1, pageSize: 20, createdTo: "2025-06-30" });

    const { sql } = listCall();
    expect(sql).toContain("v.created_at <= $1::timestamptz");
    expect(sql).not.toContain("v.created_at >=");
  });

  it("adds no date predicate when neither bound is supplied", async () => {
    await service.listVaults({ page: 1, pageSize: 20 });

    const { sql } = listCall();
    expect(sql).not.toContain("v.created_at >=");
    expect(sql).not.toContain("v.created_at <=");
  });

  it("binds the dates as parameters rather than inlining them", async () => {
    await service.listVaults({
      page: 1,
      pageSize: 20,
      createdFrom: "2025-01-01T00:00:00Z",
    });

    const { sql } = listCall();
    expect(sql).not.toContain("2025-01-01");
  });

  it("numbers placeholders correctly alongside the state filter", async () => {
    await service.listVaults({
      page: 1,
      pageSize: 20,
      state: "Active",
      createdFrom: "2025-01-01",
      createdTo: "2025-06-30",
    });

    const { sql, params } = listCall();
    expect(sql).toContain("v.state = $1");
    expect(sql).toContain("v.created_at >= $2::timestamptz");
    expect(sql).toContain("v.created_at <= $3::timestamptz");
    expect(params.slice(0, 3)).toEqual(["Active", "2025-01-01", "2025-06-30"]);
  });

  it("applies the same date range to the COUNT query so total matches", async () => {
    await service.listVaults({
      page: 1,
      pageSize: 20,
      createdFrom: "2025-01-01",
      createdTo: "2025-06-30",
    });

    const { sql, params } = countCall();
    expect(sql).toContain("COUNT(*)");
    expect(sql).toContain("v.created_at >= $1::timestamptz");
    expect(sql).toContain("v.created_at <= $2::timestamptz");
    expect(params).toEqual(["2025-01-01", "2025-06-30"]);
  });

  it("keeps the archived exclusion alongside the date range", async () => {
    await service.listVaults({ page: 1, pageSize: 20, createdFrom: "2025-01-01" });

    expect(listCall().sql).toContain("v.archived = FALSE");
  });
});
