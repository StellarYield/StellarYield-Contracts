import { PgBoss } from "pg-boss";
import type { Job, SendOptions } from "pg-boss";
import { query } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { jobDurationSeconds, jobQueueFailedTotal } from "./metrics.js";

const JOB_TYPES: Record<string, SendOptions> = {
  "indexer-backfill": { retryLimit: 5, retryDelay: 30, retryBackoff: false },
  "webhook-deliver": { retryLimit: 5, retryBackoff: true },
  "report-generate": { retryLimit: 2, retryDelay: 60, retryBackoff: false },
  "document-accessibility-check": { retryLimit: 3, retryDelay: 60, retryBackoff: true },
  "api-key-inactivity-sweep": { retryLimit: 3, retryDelay: 300, retryBackoff: false },
  "archival": { retryLimit: 3, retryDelay: 300, retryBackoff: false },
};

type JobTypeName = keyof typeof JOB_TYPES;

interface PgBossJobRow {
  id: string;
  name: string;
  data: Record<string, unknown> | null;
  state: string;
  created_on: Date;
  completed_on: Date | null;
  output: unknown;
}

async function runWithMetrics<T>(jobName: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const res = await fn();
    const durationSec = (Date.now() - start) / 1000;
    jobDurationSeconds.labels({ job_name: jobName }).observe(durationSec);
    return res;
  } catch (err) {
    const durationSec = (Date.now() - start) / 1000;
    jobDurationSeconds.labels({ job_name: jobName }).observe(durationSec);
    jobQueueFailedTotal.labels({ job_name: jobName }).inc();
    throw err;
  }
}

class JobQueue {
  private boss: PgBoss | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;

    this.boss = new PgBoss({ connectionString: config.db.url });
    await this.boss.start();

    // Schedule monthly vault report pre-generation on the 1st of each month at 00:05 UTC (#852)
    try {
      await this.boss.schedule("report-generate", "5 0 1 * *", {});
    } catch (err) {
      logger.warn({ err }, "Could not register report-generate schedule on boss start");
    }

    // Schedule daily document accessibility check at 02:00 UTC (#977)
    try {
      await this.boss.schedule("document-accessibility-check", "0 2 * * *", {});
    } catch (err) {
      logger.warn({ err }, "Could not register document-accessibility-check schedule on boss start");
    }

    // Schedule the daily API key inactivity sweep at 03:00 UTC (#934). The job
    // itself is a no-op unless KEY_INACTIVITY_DAYS is configured.
    try {
      await this.boss.schedule("api-key-inactivity-sweep", "0 3 * * *", {});
    } catch (err) {
      logger.warn({ err }, "Could not register api-key-inactivity-sweep schedule on boss start");
    }

    // Schedule archival job with pg-boss using ARCHIVE_CRON
    try {
      await this.boss.schedule("archival", config.archiveCron, {});
    } catch (err) {
      logger.warn({ err }, "Could not register archival schedule on boss start");
    }

    await this.boss.work<Record<string, unknown>>("webhook-deliver", async (jobs: Job<Record<string, unknown>>[]) => {
      const { processWebhookDelivery } = await import("./webhookWorker.js");
      for (const job of jobs) {
        await runWithMetrics("webhook-deliver", async () => {
          const { webhookId, payload } = job.data as {
            webhookId: number;
            payload: string;
          };
          await processWebhookDelivery(this.boss!, webhookId, payload);
        });
      }
    });

    await this.boss.work<Record<string, unknown>>("indexer-backfill", async (jobs: Job<Record<string, unknown>>[]) => {
      const { processIndexerBackfill } = await import("./indexerBackfillWorker.js");
      for (const job of jobs) {
        const sendProgress = async (data: { progress: number }) => {
          await this.updateJobProgress(String(job.id), data.progress);
        };
        (job as any).send = sendProgress;

        await runWithMetrics("indexer-backfill", async () => {
          const { fromLedger, toLedger } = job.data as {
            fromLedger: number;
            toLedger: number;
          };
          await processIndexerBackfill(fromLedger, toLedger, async (progress: number) => {
            await sendProgress({ progress });
          });
          await sendProgress({ progress: 100 });
        });
      }
    });

    await this.boss.work<Record<string, unknown>>("report-generate", async (jobs: Job<Record<string, unknown>>[]) => {
      const { generateVaultReports } = await import("./reportWorker.js");
      for (const _job of jobs) {
        await runWithMetrics("report-generate", async () => {
          await generateVaultReports();
        });
      }
    });

    await this.boss.work<Record<string, unknown>>("document-accessibility-check", async (jobs: Job<Record<string, unknown>>[]) => {
      const { processDocumentAccessibilityCheck } = await import("./documentAccessibilityWorker.js");
      for (const _job of jobs) {
        await runWithMetrics("document-accessibility-check", async () => {
          await processDocumentAccessibilityCheck();
        });
      }
    });

    await this.boss.work<Record<string, unknown>>("api-key-inactivity-sweep", async (jobs: Job<Record<string, unknown>>[]) => {
      const { deactivateInactiveApiKeys } = await import("./apiKeyInactivity.js");
      for (const _job of jobs) {
        await runWithMetrics("api-key-inactivity-sweep", async () => {
          await deactivateInactiveApiKeys();
        });
      }
    });

    await this.boss.work<Record<string, unknown>>("archival", async (jobs: Job<Record<string, unknown>>[]) => {
      for (const _job of jobs) {
        await runWithMetrics("archival", async () => {
          const { runArchival } = await import("./archivalService.js");
          await runArchival();
        });
      }
    });

    this.started = true;
    logger.info("pg-boss job queue started");
  }

  async stop(): Promise<void> {
    if (this.boss && this.started) {
      await this.boss.stop();
      this.started = false;
      logger.info("pg-boss job queue stopped");
    }
  }

  async send<T extends Record<string, unknown>>(
    name: JobTypeName,
    data: T,
  ): Promise<string | null> {
    if (!this.boss) throw new Error("JobQueue not started");
    const opts = JOB_TYPES[name];
    const jobId = await this.boss.send(name, data, opts);
    return jobId ? String(jobId) : null;
  }

  async updateJobProgress(jobId: string, progress: number): Promise<void> {
    try {
      await query(
        `UPDATE pgboss.job
         SET output = jsonb_build_object('progress', $2::int)
         WHERE id = $1`,
        [jobId, progress],
      );
    } catch (err) {
      logger.warn({ err, jobId, progress }, "Failed to update job progress in database");
    }
  }

  async getJob(jobId: string): Promise<Record<string, unknown> | null> {
    if (!this.boss) throw new Error("JobQueue not started");
    const rows = await query<PgBossJobRow>(
      `SELECT id, name, data, state, created_on, completed_on, output
       FROM pgboss.job
       WHERE id = $1`,
      [jobId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      data: row.data,
      state: row.state,
      createdOn: row.created_on,
      completedOn: row.completed_on,
      output: row.output,
    };
  }

  async getFailedJobs(limit = 50): Promise<Record<string, unknown>[]> {
    if (!this.boss) throw new Error("JobQueue not started");
    const rows = await query<PgBossJobRow>(
      `SELECT id, name, data, state, created_on, completed_on, output
       FROM pgboss.job
       WHERE state = 'failed'
       ORDER BY created_on DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      data: row.data,
      state: row.state,
      createdOn: row.created_on,
      completedOn: row.completed_on,
      output: row.output,
    }));
  }
}

export const jobQueue = new JobQueue();
