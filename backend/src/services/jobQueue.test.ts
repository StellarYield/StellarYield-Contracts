import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSchedule = vi.fn().mockResolvedValue("schedule-id");
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);

vi.mock("pg-boss", () => {
  const PgBoss = vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    schedule: mockSchedule,
    work: mockWork,
    send: vi.fn().mockResolvedValue("job-123"),
  }));
  return { PgBoss, default: PgBoss };
});

vi.mock("../config.js", () => ({
  config: {
    db: { url: "postgresql://localhost:5432/test" },
    logLevel: "info",
    nodeEnv: "test",
    archiveCron: "0 2 * * *",
  },
}));

vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../db/index.js", () => ({
  query: vi.fn(),
}));

describe("JobQueue Archival Schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules the archival job with the default ARCHIVE_CRON schedule ('0 2 * * *')", async () => {
    const { jobQueue } = await import("./jobQueue.js");
    const { config } = await import("../config.js");
    (config as any).archiveCron = "0 2 * * *";

    await jobQueue.start();

    expect(mockSchedule).toHaveBeenCalledWith("archival", "0 2 * * *", {});
  });

  it("schedules the archival job at 3am when ARCHIVE_CRON is '0 3 * * *'", async () => {
    const { jobQueue } = await import("./jobQueue.js");
    const { config } = await import("../config.js");
    (config as any).archiveCron = "0 3 * * *";

    // reset started flag by stopping first
    await jobQueue.stop();
    await jobQueue.start();

    expect(mockSchedule).toHaveBeenCalledWith("archival", "0 3 * * *", {});
  });

  it("registers an archival worker handler", async () => {
    const { jobQueue } = await import("./jobQueue.js");
    await jobQueue.stop();
    await jobQueue.start();

    expect(mockWork).toHaveBeenCalledWith("archival", expect.any(Function));
  });
});
