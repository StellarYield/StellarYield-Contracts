import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const h = vi.hoisted(() => ({
  batches: [] as unknown[][],
  release: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));

// pg-cursor is replaced with a fake that hands back the queued batches and then
// an empty array to signal the end of the result set.
vi.mock("pg-cursor", () => {
  class FakeCursor {
    constructor(public readonly sql: string) {}
    read = vi.fn().mockImplementation(async () => h.batches.shift() ?? []);
    close = h.close;
  }
  return { default: FakeCursor };
});

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: {
    connect: vi.fn().mockResolvedValue({
      // client.query(cursor) returns the cursor, mirroring pg's Submittable path.
      query: (cursor: unknown) => cursor,
      release: h.release,
    }),
  },
}));

import { exportPositionsCsv } from "./admin.js";

function buildApp() {
  const app = express();
  app.get("/positions/export.csv", exportPositionsCsv);
  return app;
}

describe("GET /api/v1/admin/positions/export.csv streaming (#950)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.batches = [
      [
        {
          user_address: "GAAA",
          vault_contract_id: "CBBB",
          shares: "100",
          deposited: "50",
          last_claimed_epoch: 2,
          updated_at: new Date("2025-01-01T00:00:00.000Z"),
        },
      ],
      [],
    ];
  });

  it("streams a CSV header plus rows and uses chunked transfer encoding", async () => {
    const res = await supertest(buildApp()).get("/positions/export.csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/positions-export\.csv/);
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.headers["content-length"]).toBeUndefined();

    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe(
      "user_address,vault_contract_id,shares,deposited,last_claimed_epoch,updated_at",
    );
    expect(lines[1]).toContain("GAAA,CBBB,100,50,2,");
  });

  it("releases the pooled client once the stream completes", async () => {
    await supertest(buildApp()).get("/positions/export.csv");
    expect(h.close).toHaveBeenCalled();
    expect(h.release).toHaveBeenCalled();
  });
});
