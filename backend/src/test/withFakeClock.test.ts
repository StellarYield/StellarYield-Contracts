import { describe, it, expect, vi } from "vitest";
import { withFakeClock } from "./withFakeClock.js";

describe("withFakeClock (#1293)", () => {
  it("pins Date.now() to the supplied instant", async () => {
    const iso = "2025-03-14T15:09:26.000Z";
    const seen = await withFakeClock(iso, () => Date.now());
    expect(seen).toBe(new Date(iso).getTime());
  });

  it("advances time deterministically without sleeping", async () => {
    const elapsed = await withFakeClock("2025-01-01T00:00:00.000Z", async () => {
      const start = Date.now();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      return Date.now() - start;
    });

    // Two minutes of virtual time with zero real delay.
    expect(elapsed).toBe(2 * 60 * 1000);
  });

  it("runs scheduled callbacks on the fake clock", async () => {
    const ticks: number[] = [];
    await withFakeClock(0, async () => {
      const id = setInterval(() => ticks.push(Date.now()), 1_000);
      await vi.advanceTimersByTimeAsync(3_500);
      clearInterval(id);
    });

    // The clock is pinned to the epoch, so each tick lands on a whole second.
    expect(ticks).toEqual([1_000, 2_000, 3_000]);
  });

  it("restores real timers after the callback resolves", async () => {
    await withFakeClock(0, () => undefined);
    expect(vi.isFakeTimers()).toBe(false);
    // A real timer now behaves normally and is driven by the event loop.
    const value = await new Promise<string>((resolve) => setTimeout(() => resolve("real"), 0));
    expect(value).toBe("real");
  });

  it("restores real timers even when the callback throws", async () => {
    await expect(
      withFakeClock(0, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(vi.isFakeTimers()).toBe(false);
  });

  it("rejects an invalid start date", async () => {
    await expect(withFakeClock("not-a-date", () => undefined)).rejects.toThrow(/invalid start date/);
  });
});
