import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { shutdown, SHUTDOWN_ORDER, type ShutdownDeps, type ShutdownStep } from "./shutdown.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Build a dependency bag whose steps record the order they run in and flip a
 * `closed` flag, standing in for the real server, indexer, job queue, Redis and
 * Postgres pool.
 */
function makeDeps() {
  const order: ShutdownStep[] = [];
  const closed = {
    server: false,
    indexer: false,
    jobs: false,
    redis: false,
    pool: false,
  };

  const deps: ShutdownDeps = {
    stopListening: () => {
      order.push("stopListening");
      closed.server = true;
    },
    drainIndexer: () => {
      order.push("drainIndexer");
      closed.indexer = true;
    },
    flushJobs: () => {
      order.push("flushJobs");
      closed.jobs = true;
    },
    closeRedis: () => {
      order.push("closeRedis");
      closed.redis = true;
    },
    closePool: () => {
      order.push("closePool");
      closed.pool = true;
    },
  };

  return { deps, order, closed };
}

describe("ordered shutdown (#1294)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the teardown steps in the documented order", async () => {
    const { deps, order } = makeDeps();

    const completed = await shutdown(deps);

    expect(order).toEqual([
      "stopListening",
      "drainIndexer",
      "flushJobs",
      "closeRedis",
      "closePool",
    ]);
    expect(order).toEqual([...SHUTDOWN_ORDER]);
    expect(completed).toEqual([...SHUTDOWN_ORDER]);
  });

  it("stops listening before it drains, flushes or closes anything", async () => {
    const { deps, order } = makeDeps();

    await shutdown(deps);

    expect(order[0]).toBe("stopListening");
    // The pool is the shared dependency of the indexer and job queue, so it must
    // be the very last thing closed.
    expect(order[order.length - 1]).toBe("closePool");
  });

  it("awaits each step before starting the next (no overlap)", async () => {
    const { deps, order } = makeDeps();
    const gate = deferred();

    deps.stopListening = () => {
      order.push("stopListening");
      return gate.promise;
    };

    const running = shutdown(deps);
    await Promise.resolve();
    // The first step is still in flight, so nothing else may have started.
    expect(order).toEqual(["stopListening"]);

    gate.resolve();
    const completed = await running;

    expect(order).toEqual([...SHUTDOWN_ORDER]);
    expect(completed).toHaveLength(SHUTDOWN_ORDER.length);
  });

  it("leaves every resource reported closed", async () => {
    const { deps, closed } = makeDeps();

    await shutdown(deps);

    expect(closed).toEqual({
      server: true,
      indexer: true,
      jobs: true,
      redis: true,
      pool: true,
    });
  });

  it("continues past a failing step so later resources are still released", async () => {
    const { deps, order, closed } = makeDeps();
    deps.drainIndexer = () => {
      order.push("drainIndexer");
      throw new Error("indexer drain failed");
    };

    const completed = await shutdown(deps);

    // The failing step is reported as not completed, but the pool is still
    // closed rather than the whole sequence aborting.
    expect(completed).not.toContain("drainIndexer");
    expect(order).toEqual(["stopListening", "drainIndexer", "flushJobs", "closeRedis", "closePool"]);
    expect(closed.pool).toBe(true);
    expect(closed.redis).toBe(true);
  });

  it("is safe to call with steps that do nothing", async () => {
    const noop = () => undefined;
    const completed = await shutdown({
      stopListening: noop,
      drainIndexer: noop,
      flushJobs: noop,
      closeRedis: noop,
      closePool: noop,
    });

    expect(completed).toEqual([...SHUTDOWN_ORDER]);
  });
});
