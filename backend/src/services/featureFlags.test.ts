import { describe, it, expect, vi, beforeEach } from "vitest";
import { withFakeClock } from "../test/withFakeClock.js";

type FeatureFlagsModule = typeof import("./featureFlags.js");

/**
 * The flag store is module-level state, so each test loads a fresh copy of the
 * module. Otherwise flags written by one test would leak into the next.
 */
async function loadFlags(): Promise<FeatureFlagsModule> {
  vi.resetModules();
  return import("./featureFlags.js");
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `client-${i}`);
}

describe("featureFlags service", () => {
  let flags: FeatureFlagsModule;

  beforeEach(async () => {
    flags = await loadFlags();
  });

  describe("defaults and storage", () => {
    it("treats an unknown flag as disabled", () => {
      expect(flags.getFlag("never-defined")).toBeUndefined();
      expect(flags.isFlagEnabled("never-defined", "203.0.113.7")).toBe(false);
      expect(flags.listFlags()).toEqual([]);
    });

    it("creates a new flag with the documented defaults", () => {
      const flag = flags.upsertFlag("new-flag", {});

      expect(flag).toMatchObject({
        name: "new-flag",
        enabled: false,
        enabledForRoles: [],
        rolloutPercent: 0,
      });
    });

    it("stamps updatedAt from the current clock", async () => {
      await withFakeClock("2026-11-22T12:00:00.000Z", () => {
        const flag = flags.upsertFlag("timed", { enabled: true });

        expect(flag.updatedAt.toISOString()).toBe("2026-11-22T12:00:00.000Z");
      });
    });

    it("merges a patch into the existing record and keeps untouched fields", () => {
      flags.upsertFlag("merge", { enabled: true, rolloutPercent: 30, enabledForRoles: ["admin"] });

      const updated = flags.upsertFlag("merge", { rolloutPercent: 60 });

      expect(updated).toMatchObject({
        enabled: true,
        rolloutPercent: 60,
        enabledForRoles: ["admin"],
      });
      expect(flags.getFlag("merge")).toMatchObject({ enabled: true, rolloutPercent: 60 });
    });
  });

  describe("resolution order (documented precedence)", () => {
    it("is off when the flag is disabled, even at 100% rollout", () => {
      flags.upsertFlag("disabled-full", { enabled: false, rolloutPercent: 100 });

      for (const id of ids(20)) {
        expect(flags.isFlagEnabled("disabled-full", id)).toBe(false);
      }
    });

    it("is on for every request when enabled at 100% rollout", () => {
      flags.upsertFlag("everyone", { enabled: true, rolloutPercent: 100 });

      for (const id of [...ids(20), "10.0.0.1", "unknown"]) {
        expect(flags.isFlagEnabled("everyone", id)).toBe(true);
      }
    });

    it("is off for every request when enabled at 0% rollout", () => {
      flags.upsertFlag("nobody", { enabled: true, rolloutPercent: 0 });

      for (const id of ids(20)) {
        expect(flags.isFlagEnabled("nobody", id)).toBe(false);
      }
    });

    it("gives the same decision for the same requestId on every call", () => {
      flags.upsertFlag("sticky", { enabled: true, rolloutPercent: 50 });

      const first = flags.isFlagEnabled("sticky", "203.0.113.7");
      for (let i = 0; i < 25; i++) {
        expect(flags.isFlagEnabled("sticky", "203.0.113.7")).toBe(first);
      }
    });

    it("enables roughly the configured share of requests under partial rollout", () => {
      flags.upsertFlag("quarter", { enabled: true, rolloutPercent: 25 });

      const enabled = ids(2000).filter((id) => flags.isFlagEnabled("quarter", id)).length;

      // Deterministic: the bucket is a SHA-256 prefix, so this count never varies between runs.
      // The 400-600 window is loose enough to be an honest check of the 25% target.
      expect(enabled).toBeGreaterThanOrEqual(400);
      expect(enabled).toBeLessThanOrEqual(600);
    });

    it("picks up a changed rollout on the next evaluation", () => {
      flags.upsertFlag("ramp", { enabled: true, rolloutPercent: 0 });
      expect(flags.isFlagEnabled("ramp", "198.51.100.4")).toBe(false);

      flags.upsertFlag("ramp", { rolloutPercent: 100 });
      expect(flags.isFlagEnabled("ramp", "198.51.100.4")).toBe(true);
    });

    it("does not gate on enabledForRoles (documented limitation)", () => {
      flags.upsertFlag("role-only", { enabled: true, rolloutPercent: 100, enabledForRoles: ["admin"] });

      expect(flags.isFlagEnabled("role-only", "anonymous-client")).toBe(true);
    });
  });
});
