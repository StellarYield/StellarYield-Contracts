import { describe, it, expect, vi, afterEach } from "vitest";
import { rpcConcurrentRequestsLimited } from "./metrics.js";
import { rpcSemaphore, withRpcLimit } from "./rpcLimiter.js";

// The semaphore is process-wide and sized from RPC_MAX_CONCURRENT_REQUESTS, so
// the tests read the configured limit instead of assuming a fixed value.
const LIMIT = rpcSemaphore.getStats().total;

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function gate(): Gate {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets queued acquire() continuations run before the semaphore is inspected.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RPC concurrency limiter (#1396)", () => {
  it("never runs more requests at once than the configured limit", async () => {
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: LIMIT + 5 }, () => gate());

    const calls = gates.map((g) =>
      withRpcLimit(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }),
    );

    await settle();
    expect(running).toBe(LIMIT);
    expect(rpcSemaphore.getStats()).toEqual({ total: LIMIT, available: 0, waiting: 5 });

    gates.forEach((g) => g.resolve());
    await Promise.all(calls);

    expect(peak).toBe(LIMIT);
    expect(rpcSemaphore.getStats()).toEqual({ total: LIMIT, available: LIMIT, waiting: 0 });
  });

  it("queues a request beyond the limit and starts it once a slot is released", async () => {
    const queuedCounter = vi.spyOn(rpcConcurrentRequestsLimited, "inc");
    const holders = Array.from({ length: LIMIT }, () => gate());
    const holding = holders.map((g) => withRpcLimit(() => g.promise));

    let started = false;
    const queued = withRpcLimit(async () => {
      started = true;
    });

    await settle();
    expect(started).toBe(false);
    expect(rpcSemaphore.getStats().waiting).toBe(1);
    expect(queuedCounter).toHaveBeenCalledTimes(1);

    holders[0].resolve();
    await queued;
    expect(started).toBe(true);

    holders.slice(1).forEach((g) => g.resolve());
    await Promise.all(holding);
    expect(rpcSemaphore.getStats()).toEqual({ total: LIMIT, available: LIMIT, waiting: 0 });
  });

  it("releases its slot when the request fails, so a queued request can run", async () => {
    const holders = Array.from({ length: LIMIT }, () => gate());
    const holding = holders.map((g) => withRpcLimit(() => g.promise));
    const queued = withRpcLimit(async () => "ran");

    holders[0].reject(new Error("RPC timeout"));

    await expect(holding[0]).rejects.toThrow("RPC timeout");
    await expect(queued).resolves.toBe("ran");

    holders.slice(1).forEach((g) => g.resolve());
    await Promise.allSettled(holding);
    expect(rpcSemaphore.getStats()).toEqual({ total: LIMIT, available: LIMIT, waiting: 0 });
  });
});
