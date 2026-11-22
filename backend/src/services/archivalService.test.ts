import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { query } from "../db/index.js";
import { runArchival } from "./archivalService.js";

const archiveConfig = vi.hoisted(() => ({
  eventsRetentionDays: 90,
  snapshotRetentionDays: undefined as number | undefined,
  tvlSnapshotRetentionDays: undefined as number | undefined,
  dryRun: false,
}));

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../config.js", () => ({ config: archiveConfig }));
vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type QueryCall = [string, unknown[]?];

/**
 * Answer the SQL that runArchival issues.
 *
 * `oldRows` is how many rows per live table are past the retention cutoff. An
 * archive insert returns one row per row it copies, as the real query does
 * through RETURNING 1. `archiveWriteError`, when set, makes every archive insert
 * reject.
 */
function mockDatabase(options: {
  oldRows?: Record<string, number>;
  archiveWriteError?: Error;
}): void {
  const oldRows = options.oldRows ?? {};

  (query as unknown as Mock).mockImplementation(async (sql: string) => {
    const countMatch = sql.match(/SELECT COUNT\(\*\)::text AS count\s+FROM (\w+) t/);
    if (countMatch) {
      return [{ count: String(oldRows[countMatch[1]] ?? 0) }];
    }

    const insertMatch = sql.match(/INSERT INTO (\w+)_archive\b/);
    if (insertMatch && sql.includes("RETURNING 1")) {
      if (options.archiveWriteError) throw options.archiveWriteError;
      return Array.from({ length: oldRows[insertMatch[1]] ?? 0 }, () => ({ count: "1" }));
    }

    return [];
  });
}

function calls(): string[] {
  return (query as unknown as Mock).mock.calls.map((c: QueryCall) => c[0]);
}

describe("runArchival", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archiveConfig.dryRun = false;
    archiveConfig.eventsRetentionDays = 90;
  });

  it("removes live rows only after the archive insert has succeeded", async () => {
    mockDatabase({ oldRows: { indexed_events: 3 } });

    const results = await runArchival();

    const sqls = calls();
    const insertAt = sqls.findIndex((s) => s.includes("INSERT INTO indexed_events_archive"));
    const deleteAt = sqls.findIndex((s) => /DELETE FROM indexed_events t/.test(s));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(insertAt);

    expect(results[0]).toEqual({
      table: "indexed_events",
      preArchivalCount: 3,
      archivedCount: 3,
      dryRun: false,
    });
  });

  it("does not delete live rows when the archive write fails", async () => {
    mockDatabase({
      oldRows: { indexed_events: 3 },
      archiveWriteError: new Error("archive volume is full"),
    });

    await expect(runArchival()).rejects.toThrow("archive volume is full");

    const sqls = calls();
    expect(sqls.some((s) => /DELETE FROM/.test(s))).toBe(false);
    expect(sqls.some((s) => s.includes("INSERT INTO archive_audit_log"))).toBe(false);
  });

  it("archives nothing when no rows are past the retention cutoff", async () => {
    mockDatabase({ oldRows: {} });

    const results = await runArchival();

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toMatchObject({ preArchivalCount: 0, archivedCount: 0, dryRun: false });
    }
    const sqls = calls();
    expect(sqls.some((s) => /INSERT INTO \w+_archive\b/.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM/.test(s))).toBe(false);
  });

  it("reports what would be archived in dry-run mode without writing", async () => {
    archiveConfig.dryRun = true;
    mockDatabase({ oldRows: { indexed_events: 2 } });

    const results = await runArchival();

    expect(results[0]).toEqual({
      table: "indexed_events",
      preArchivalCount: 2,
      archivedCount: 0,
      dryRun: true,
    });

    const sqls = calls();
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS"))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO \w+_archive\b/.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM/.test(s))).toBe(false);

    const auditCall = (query as unknown as Mock).mock.calls.find((c: QueryCall) =>
      c[0].includes("archive_audit_log"),
    );
    expect(auditCall?.[0]).toContain("VALUES ($1, $2, 0, TRUE)");
    expect(auditCall?.[1]).toEqual(["indexed_events", 2]);
  });

  it("selects only rows older than the configured retention, and skips excluded vaults", async () => {
    // One old row, so the delete statement runs and can be inspected.
    mockDatabase({ oldRows: { indexed_events: 1 } });

    await runArchival();

    // Only rows strictly older than NOW() - retention are selected, so newer rows are never archived.
    const countSql = calls().find((s) => /FROM indexed_events t/.test(s) && s.includes("COUNT"));
    expect(countSql).toContain("t.created_at < NOW() - (90::int * INTERVAL '1 day')");
    expect(countSql).toContain("v.exclude_from_archive = FALSE");

    const insertSql = calls().find((s) => s.includes("INSERT INTO indexed_events_archive"));
    expect(insertSql).toContain("t.created_at < NOW() - (90::int * INTERVAL '1 day')");

    const deleteSql = calls().find((s) => /DELETE FROM indexed_events t/.test(s));
    expect(deleteSql).toContain("v.exclude_from_archive = TRUE");
  });
});
