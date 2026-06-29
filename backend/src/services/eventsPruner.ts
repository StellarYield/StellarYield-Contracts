import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000;

export class EventsPruner {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.runOnce().catch((err) => logger.error({ err }, "EventsPruner: initial run failed"));
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ err }, "EventsPruner: scheduled run failed"));
    }, INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runOnce(): Promise<void> {
    const retentionDays = config.eventsRetentionDays;

    const pruned = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM indexed_events
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
         RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [retentionDays],
    );
    const deletedCount = parseInt(pruned[0]?.count ?? "0", 10);

    const sizeRows = await query<{ total_bytes: string }>(
      `SELECT pg_total_relation_size('indexed_events')::text AS total_bytes`,
    );
    const totalBytes = sizeRows[0]?.total_bytes ?? "0";

    logger.info({ deletedCount, totalBytes, retentionDays }, "EventsPruner: pruning complete");
  }
}
