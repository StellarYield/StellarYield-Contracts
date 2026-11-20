import { vi } from "vitest";

/** A point in time accepted by {@link withFakeClock}. */
export type FakeClockStart = Date | number | string;

/**
 * Run `fn` with Vitest's fake timers and a pinned wall clock (#1293).
 *
 * Time-dependent logic — epoch expiry, maturity windows, poll intervals,
 * "last seen" stamps — is otherwise tested with real sleeps, which makes the
 * suite slow and flaky. Wrapping it in `withFakeClock` pins `Date.now()` to a
 * known instant and swaps `setTimeout`/`setInterval` for Vitest's synchronous
 * implementations, so a test can jump forward with `vi.advanceTimersByTime`
 * instead of waiting.
 *
 * Real timers are always restored (`vi.useRealTimers()`), even when `fn`
 * throws, so a failing assertion can never leak fake timers into the next test.
 *
 * @example
 * const at = await withFakeClock("2025-01-01T00:00:00.000Z", async () => {
 *   const start = Date.now();
 *   await vi.advanceTimersByTimeAsync(30_000);
 *   return Date.now() - start;
 * });
 * expect(at).toBe(30_000);
 */
export async function withFakeClock<T>(
  date: FakeClockStart,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(start.getTime())) {
    throw new TypeError(`withFakeClock: invalid start date: ${String(date)}`);
  }

  vi.useFakeTimers();
  vi.setSystemTime(start);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
