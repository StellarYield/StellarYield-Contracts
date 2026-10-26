import { describe, it, expect, vi, afterEach } from "vitest";
import { pool, query, withTransaction } from "./index.js";

// A stand-in connection that records every statement it is asked to run.
function fakeClient() {
  const statements: string[] = [];
  const client = {
    statements,
    query: vi.fn(async (sql: unknown) => {
      statements.push(typeof sql === "string" ? sql : String((sql as { text: string }).text));
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return client;
}

describe("withTransaction (#1210)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits when the callback resolves", async () => {
    const client = fakeClient();
    vi.spyOn(pool, "connect").mockResolvedValue(client as never);

    const result = await withTransaction(async () => {
      await query("INSERT INTO indexed_events (ledger) VALUES ($1)", [1]);
      return "done";
    });

    expect(result).toBe("done");
    expect(client.statements).toEqual([
      "BEGIN",
      "INSERT INTO indexed_events (ledger) VALUES ($1)",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back every write, including the cursor, when a later step fails", async () => {
    const client = fakeClient();
    vi.spyOn(pool, "connect").mockResolvedValue(client as never);

    await expect(
      withTransaction(async () => {
        await query("INSERT INTO indexed_events (ledger) VALUES ($1)", [1]);
        await query("INSERT INTO indexed_events (ledger) VALUES ($1)", [2]);
        throw new Error("injected mid-batch failure");
      }),
    ).rejects.toThrow("injected mid-batch failure");

    expect(client.statements).toEqual([
      "BEGIN",
      "INSERT INTO indexed_events (ledger) VALUES ($1)",
      "INSERT INTO indexed_events (ledger) VALUES ($1)",
      "ROLLBACK",
    ]);
    expect(client.statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("runs queries outside the callback on the pool, not the transaction client", async () => {
    const client = fakeClient();
    vi.spyOn(pool, "connect").mockResolvedValue(client as never);
    const poolQuery = vi.spyOn(pool, "query").mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await withTransaction(async () => undefined);
    await query("SELECT 1");

    expect(poolQuery).toHaveBeenCalledWith("SELECT 1", undefined);
    expect(client.statements).toEqual(["BEGIN", "COMMIT"]);
  });
});
