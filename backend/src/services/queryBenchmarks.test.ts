import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn(), pool: {} }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { benchDeploy, compareBenchmarks, HOT_QUERIES } from "./queryBenchmarks.js";
import { query } from "../db/index.js";

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HOT_QUERIES (Issue #964)", () => {
  it("defines a top-10 set of hot queries", () => {
    expect(HOT_QUERIES.length).toBe(10);
  });

  it("uses distinct query names", () => {
    const names = HOT_QUERIES.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("benchDeploy", () => {
  it("records a duration for every hot query on a fresh deploy", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM query_benchmarks")) return [];
      if (sql.includes("INSERT INTO query_benchmarks")) return [];
      return [];
    });

    const ran = await benchDeploy("deploy-a");

    expect(ran).toBe(true);
    const inserts = mockQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO query_benchmarks"),
    );
    expect(inserts.length).toBe(10);
    expect(inserts[0][1][0]).toBe("deploy-a");
    expect(inserts[0][1][1]).toBe(HOT_QUERIES[0].name);
  });

  it("is a no-op when benchmarks already exist for the deploy", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM query_benchmarks")) return [{ id: 1 }];
      return [];
    });

    const ran = await benchDeploy("deploy-a");
    expect(ran).toBe(false);
    expect(
      mockQuery.mock.calls.some((c) => String(c[0]).includes("INSERT INTO query_benchmarks")),
    ).toBe(false);
  });
});

describe("compareBenchmarks", () => {
  it("flags queries that regressed by more than 20%", async () => {
    mockQuery.mockResolvedValue([
      { query: "vault_list", base_duration: 100, head_duration: 150 },
      { query: "vault_detail", base_duration: 100, head_duration: 90 },
    ]);

    const result = await compareBenchmarks("base", "head");

    expect(result).toHaveLength(2);
    const list = result.find((r) => r.query === "vault_list")!;
    expect(list.regressionPct).toBe(50);
    expect(list.isRegression).toBe(true);
    const detail = result.find((r) => r.query === "vault_detail")!;
    expect(detail.regressionPct).toBe(-10);
    expect(detail.isRegression).toBe(false);
  });

  it("does not flag a regression exactly at the 20% threshold", async () => {
    mockQuery.mockResolvedValue([
      { query: "vault_list", base_duration: 100, head_duration: 120 },
    ]);

    const result = await compareBenchmarks("base", "head");
    expect(result[0].regressionPct).toBe(20);
    expect(result[0].isRegression).toBe(false);
  });
});
