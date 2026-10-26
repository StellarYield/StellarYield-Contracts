import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query } from "../db/index.js";
import { withFakeClock } from "../test/withFakeClock.js";
import { setJobQueueDepth } from "./metrics.js";
import {
  fetchJobQueueDepth,
  JOB_QUEUE_DEPTH_POLL_INTERVAL_MS,
  JobQueueDepthPoller,
} from "./jobQueueDepthPoller.js";

const mockQuery = query as ReturnType<typeof vi.fn>;

async function scrapeGauges(): Promise<string> {
  const { getMetrics } = await import("./metrics.js");
  return (await getMetrics())
    .split("\n")
    .filter((line) => line.startsWith("pgboss_jobs_"))
    .join("\n");
}

/**
 * Number of queue-depth samples taken. Scraping metrics also hits the database
 * (for the per-job pending gauge), so counting every query would be misleading.
 */
function depthSampleCount(): number {
  return mockQuery.mock.calls.filter(([sql]) => String(sql).includes("FILTER")).length;
}

describe("pg-boss queue depth gauges (#1093)", () => {
  beforeEach(() => {
    setJobQueueDepth({ created: 0, active: 0, failed: 0 });
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts jobs by state in a single query", async () => {
    mockQuery.mockResolvedValueOnce([{ created: "7", active: "2", failed: "1" }]);

    await expect(fetchJobQueueDepth()).resolves.toEqual({ created: 7, active: 2, failed: 1 });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("FROM pgboss.job");
    expect(sql).toContain("state = 'created'");
    expect(sql).toContain("state = 'active'");
    expect(sql).toContain("state = 'failed'");
  });

  it("reports zero for an empty queue", async () => {
    mockQuery.mockResolvedValueOnce([{ created: "0", active: "0", failed: "0" }]);

    await expect(fetchJobQueueDepth()).resolves.toEqual({ created: 0, active: 0, failed: 0 });
  });

  it("treats a missing row or a null count as zero", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(fetchJobQueueDepth()).resolves.toEqual({ created: 0, active: 0, failed: 0 });

    mockQuery.mockResolvedValueOnce([{ created: null, active: null, failed: null }]);
    await expect(fetchJobQueueDepth()).resolves.toEqual({ created: 0, active: 0, failed: 0 });
  });

  it("exposes all three gauges on /metrics", async () => {
    setJobQueueDepth({ created: 4, active: 3, failed: 2 });

    const gauges = await scrapeGauges();
    expect(gauges).toContain("pgboss_jobs_created 4");
    expect(gauges).toContain("pgboss_jobs_active 3");
    expect(gauges).toContain("pgboss_jobs_failed 2");
  });

  it("publishes a sample on start and every 30s afterwards", async () => {
    await withFakeClock("2025-01-01T00:00:00.000Z", async () => {
      mockQuery.mockResolvedValue([{ created: "1", active: "0", failed: "0" }]);

      const poller = new JobQueueDepthPoller();
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(depthSampleCount()).toBe(1);
      expect(await scrapeGauges()).toContain("pgboss_jobs_created 1");

      mockQuery.mockResolvedValue([{ created: "5", active: "2", failed: "4" }]);
      await vi.advanceTimersByTimeAsync(JOB_QUEUE_DEPTH_POLL_INTERVAL_MS);
      expect(depthSampleCount()).toBe(2);
      expect(await scrapeGauges()).toContain("pgboss_jobs_created 5");
      expect(await scrapeGauges()).toContain("pgboss_jobs_failed 4");

      poller.stop();
      await vi.advanceTimersByTimeAsync(JOB_QUEUE_DEPTH_POLL_INTERVAL_MS * 3);
      expect(depthSampleCount()).toBe(2);
    });
  });

  it("polls every 30 seconds", () => {
    expect(JOB_QUEUE_DEPTH_POLL_INTERVAL_MS).toBe(30_000);
  });

  it("skips a tick while the previous sample is still in flight", async () => {
    await withFakeClock("2025-01-01T00:00:00.000Z", async () => {
      let release: (() => void) | undefined;
      let calls = 0;
      mockQuery.mockImplementation(() => {
        calls += 1;
        // Only the first sample hangs; anything after it (including the metric
        // scrapes) resolves immediately.
        if (calls > 1) return Promise.resolve([{ created: "0", active: "0", failed: "0" }]);
        return new Promise((resolve) => {
          release = () => resolve([{ created: "1", active: "1", failed: "1" }]);
        });
      });

      const poller = new JobQueueDepthPoller();
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(depthSampleCount()).toBe(1);

      // A slow database must not stack up overlapping count queries.
      await vi.advanceTimersByTimeAsync(JOB_QUEUE_DEPTH_POLL_INTERVAL_MS);
      expect(depthSampleCount()).toBe(1);

      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(await scrapeGauges()).toContain("pgboss_jobs_failed 1");

      // The next tick is sampled normally again.
      await vi.advanceTimersByTimeAsync(JOB_QUEUE_DEPTH_POLL_INTERVAL_MS);
      expect(depthSampleCount()).toBe(2);

      poller.stop();
    });
  });

  it("keeps the last sample when the query fails", async () => {
    setJobQueueDepth({ created: 9, active: 8, failed: 7 });
    vi.useFakeTimers();
    mockQuery.mockRejectedValue(new Error("relation pgboss.job does not exist"));

    const poller = new JobQueueDepthPoller();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // A stale sample is more useful than a value that was never measured.
    expect(await scrapeGauges()).toContain("pgboss_jobs_created 9");
    expect(await scrapeGauges()).toContain("pgboss_jobs_failed 7");

    poller.stop();
  });

  it("recovers on the next tick after a failed sample", async () => {
    vi.useFakeTimers();
    mockQuery.mockRejectedValueOnce(new Error("database unavailable"));

    const poller = new JobQueueDepthPoller();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await scrapeGauges()).toContain("pgboss_jobs_created 0");

    mockQuery.mockResolvedValue([{ created: "6", active: "1", failed: "0" }]);
    await vi.advanceTimersByTimeAsync(JOB_QUEUE_DEPTH_POLL_INTERVAL_MS);
    expect(await scrapeGauges()).toContain("pgboss_jobs_created 6");

    poller.stop();
  });
});
