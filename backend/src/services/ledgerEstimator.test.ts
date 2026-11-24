import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { query } from "../db/index.js";
import { ledgerToTimestamp } from "./ledgerEstimator.js";
import { withFakeClock } from "../test/withFakeClock.js";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOW = new Date("2026-11-22T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// Anchors as ledger_anchors stores them. `ledger` is BIGINT, so pg returns it as a string.
const ANCHORS = [
  { ledger: "1000", closed_at: new Date(NOW.getTime() - HOUR_MS) },
  { ledger: "1720", closed_at: new Date(NOW.getTime() - 30 * MINUTE_MS) },
  { ledger: "2000", closed_at: new Date(NOW.getTime()) },
];

/**
 * Answer the two anchor lookups that ledgerToTimestamp issues, using an
 * in-memory table. The lower lookup filters on `ledger <= $1` and the upper
 * lookup on `ledger >= $1`.
 */
function useAnchors(anchors: Array<{ ledger: string; closed_at: Date }>): void {
  (query as unknown as Mock).mockImplementation(async (sql: string, params: unknown[]) => {
    const seq = Number(params[0]);
    const isLower = sql.includes("ledger <= $1");
    const rows = anchors
      .filter((a) => (isLower ? Number(a.ledger) <= seq : Number(a.ledger) >= seq))
      .sort((a, b) =>
        isLower ? Number(b.ledger) - Number(a.ledger) : Number(a.ledger) - Number(b.ledger),
      );
    return rows.slice(0, 1);
  });
}

describe("ledgerToTimestamp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for a ledger in the past, before the earliest anchor", () =>
    withFakeClock(NOW, async () => {
      useAnchors(ANCHORS);

      await expect(ledgerToTimestamp(999)).resolves.toBeNull();
    }));

  it("returns null for a ledger in the future, after the latest anchor", () =>
    withFakeClock(NOW, async () => {
      useAnchors(ANCHORS);

      await expect(ledgerToTimestamp(2001)).resolves.toBeNull();
    }));

  it("returns the recorded close time for the latest known ledger", () =>
    withFakeClock(NOW, async () => {
      useAnchors(ANCHORS);

      const estimate = await ledgerToTimestamp(2000);

      expect(estimate).toEqual(ANCHORS[2].closed_at);
      expect(estimate?.getTime()).toBe(NOW.getTime());
    }));

  it("returns the recorded close time for the earliest anchor", () =>
    withFakeClock(NOW, async () => {
      useAnchors(ANCHORS);

      const estimate = await ledgerToTimestamp(1000);

      expect(estimate?.getTime()).toBe(NOW.getTime() - HOUR_MS);
    }));

  it("interpolates linearly between two anchors", () =>
    withFakeClock(NOW, async () => {
      useAnchors(ANCHORS);

      // Ledger 1360 is halfway between anchors 1000 and 1720.
      const estimate = await ledgerToTimestamp(1360);

      const midpoint = (NOW.getTime() - HOUR_MS + (NOW.getTime() - 30 * MINUTE_MS)) / 2;
      expect(estimate?.getTime()).toBe(midpoint);
    }));

  it("is monotonic in ledger sequence across the whole known range", () =>
    withFakeClock(NOW, async () => {
      useAnchors(ANCHORS);

      let previous = -Infinity;
      for (let seq = 1000; seq <= 2000; seq++) {
        const estimate = await ledgerToTimestamp(seq);
        expect(estimate, `ledger ${seq}`).not.toBeNull();
        const ms = estimate!.getTime();
        expect(ms, `ledger ${seq}`).toBeGreaterThanOrEqual(previous);
        previous = ms;
      }
    }));

  it("returns null when no anchors have been recorded", () =>
    withFakeClock(NOW, async () => {
      useAnchors([]);

      await expect(ledgerToTimestamp(1500)).resolves.toBeNull();
    }));
});
