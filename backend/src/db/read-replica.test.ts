import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake pg so importing the db module never touches a real server. Each Pool
// instance records the connection string it was built with and stubs query().
vi.mock("pg", () => {
  class FakePool {
    connectionString: string;
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    connect = vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    });
    end = vi.fn().mockResolvedValue(undefined);
    waitingCount = 0;
    constructor(opts: { connectionString: string }) {
      this.connectionString = opts.connectionString;
    }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

describe("Read-replica routing (#949)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["DATABASE_READ_URL"];
  });

  it("routes GET-handler reads to the replica and writes to the primary", async () => {
    process.env["DATABASE_READ_URL"] = "postgresql://replica-host:5432/db";
    const { pool, readPool, query } = await import("./index.js");
    const { requestStore } = await import("../api/middleware/requestContext.js");

    expect(readPool).not.toBe(pool);

    await requestStore.run({ route: "/api/v1/vaults", method: "GET" }, () =>
      query("SELECT 1"),
    );
    expect((readPool as any).query).toHaveBeenCalledTimes(1);
    expect((pool as any).query).not.toHaveBeenCalled();

    await requestStore.run({ route: "/api/v1/vaults", method: "POST" }, () =>
      query("INSERT INTO vaults DEFAULT VALUES"),
    );
    expect((pool as any).query).toHaveBeenCalledTimes(1);
    expect((readPool as any).query).toHaveBeenCalledTimes(1);

    // A write fired from inside a GET handler (e.g. the api_keys last-used
    // stamp) still goes to the primary.
    await requestStore.run({ route: "/api/v1/vaults", method: "GET" }, () =>
      query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [1]),
    );
    expect((pool as any).query).toHaveBeenCalledTimes(2);
    expect((readPool as any).query).toHaveBeenCalledTimes(1);
  });

  it("sends everything to the primary when DATABASE_READ_URL is unset", async () => {
    const { pool, readPool, query } = await import("./index.js");
    const { requestStore } = await import("../api/middleware/requestContext.js");

    expect(readPool).toBe(pool);

    await requestStore.run({ route: "/api/v1/vaults", method: "GET" }, () =>
      query("SELECT 1"),
    );
    await query("SELECT 2");

    expect((pool as any).query).toHaveBeenCalledTimes(2);
  });
});
