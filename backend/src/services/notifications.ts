import { createHmac } from "crypto";
import { lookup } from "dns/promises";
import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { sseService } from "./sse.js";
import { jobQueue } from "./jobQueue.js";
import { sendEmail } from "./email.js";
import { resolveUserEvent } from "./notificationEvents.js";
import { isDeliveryEnabled } from "./notificationPreferences.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "100.100.100.200",
]);

function isPrivateIp(ip: string): boolean {
  const v4 = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
  ];
  const v6 = [/^::1$/, /^fe80:/i, /^fc00:/i, /^fd[0-9a-f]{2}:/i, /^::$/];
  return v4.some((r) => r.test(ip)) || v6.some((r) => r.test(ip));
}

export async function validateWebhookUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) throw new Error("Webhook URL hostname is not allowed");

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error("Unable to resolve webhook URL hostname");
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error("Webhook URL resolves to a private or reserved address");
    }
  }
}

interface WebhookRow {
  id: number;
  url: string;
  events: string[];
  secret: string | null;
  consecutive_failures: number;
  channel: string | null;
  priority: number;
  fallback_channel: number | null;
}

const GLOBAL_OPT_OUT_KEY = "notificationsGloballyEnabled";

/** Max delivery attempts before a webhook_deliveries row is considered exhausted. */
const MAX_DELIVERY_ATTEMPTS = 6;

export class NotificationService {
  /**
   * Whether notification dispatch is globally enabled (#994).
   * Backed by the `app_config` key/value table (#804); defaults to enabled
   * if the key has never been set (e.g. on a database seeded before this
   * migration ran).
   */
  async isGloballyEnabled(): Promise<boolean> {
    const rows = await query<{ value: string }>(
      "SELECT value FROM app_config WHERE key = $1",
      [GLOBAL_OPT_OUT_KEY],
    );
    if (rows.length === 0) return true;
    return rows[0].value === "true";
  }

  /**
   * Set the global notification opt-out flag (#994). When disabled, `notify`
   * short-circuits before any webhook is dispatched.
   */
  async setGloballyEnabled(enabled: boolean): Promise<void> {
    await query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [GLOBAL_OPT_OUT_KEY, String(enabled)],
    );
  }

  /**
   * Dispatch an event notification to all active webhooks subscribed to it.
   *
   * @remarks Each webhook payload is HMAC-SHA256 signed with the webhook's
   * secret (if configured) before delivery. Refer to {@link deliver} for the
   * signing and SSRF-safe delivery logic. Skips dispatch entirely when the
   * global opt-out flag is set (#994).
   */
  async notify(event: string, data: Record<string, unknown>): Promise<void> {
    if (!(await this.isGloballyEnabled())) return;

    const webhooks = await query<WebhookRow>(
      `SELECT id, url, events, secret, consecutive_failures, channel, priority, fallback_channel
       FROM webhooks
       WHERE active = TRUE AND $1 = ANY(events)
       ORDER BY priority ASC, created_at DESC`,
      [event],
    );

    if (webhooks.length === 0) return;

    // For user-specific events (deposit, withdrawal, yield claim), drop any
    // channel the affected user has opted out of. Users with no preference
    // row default to enabled (#990).
    let deliverable = webhooks;
    const resolved = resolveUserEvent(event, data);
    if (resolved) {
      const vaultContractId =
        typeof data["contractId"] === "string" ? (data["contractId"] as string) : null;
      const allowed = await Promise.all(
        webhooks.map((webhook) =>
          isDeliveryEnabled(
            resolved.userAddress,
            resolved.eventType,
            webhook.channel ?? "webhook",
            vaultContractId,
          ),
        ),
      );
      deliverable = webhooks.filter((_, i) => allowed[i]);
      if (deliverable.length === 0) return;
    }

    // Attempt channels in ascending priority order (lower value = higher
    // priority). Channels that share a priority are dispatched concurrently;
    // each priority tier is enqueued before the next one starts (#1025).
    const tiers = new Map<number, WebhookRow[]>();
    for (const webhook of deliverable) {
      const tier = tiers.get(webhook.priority) ?? [];
      tier.push(webhook);
      tiers.set(webhook.priority, tier);
    }

    for (const priority of [...tiers.keys()].sort((a, b) => a - b)) {
      await Promise.allSettled(
        tiers.get(priority)!.map((webhook) => {
          if (webhook.channel === "email") {
            return this.sendEmailNotification(event, data, webhook.url);
          } else {
            const payload = webhook.channel === "slack"
              ? this.formatSlackPayload(event, data)
              : JSON.stringify({ event, data, timestamp: new Date().toISOString() });
            return jobQueue.send("webhook-deliver", { webhookId: webhook.id, payload });
          }
        }),
      );
    }
  }

  private formatSlackPayload(event: string, data: Record<string, unknown>): string {
    const vaultName = (data.vaultName as string) || (data.name as string) || "Unknown Vault";
    const keyData = Object.entries(data)
      .filter(([key]) => key !== "vaultName" && key !== "name")
      .map(([key, value]) => `*${key}*: ${value}`)
      .join("\n");

    const slackPayload = {
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `StellarYield Event: ${event}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Vault*: ${vaultName}\n*Event Type*: ${event}\n\n${keyData}`,
          },
        },
      ],
    };

    return JSON.stringify(slackPayload);
  }

  private async sendEmailNotification(event: string, data: Record<string, unknown>, email: string): Promise<void> {
    const vaultName = (data.vaultName as string) || (data.name as string) || "Unknown Vault";
    const keyData = Object.entries(data)
      .filter(([key]) => key !== "vaultName" && key !== "name")
      .map(([key, value]) => `<strong>${key}:</strong> ${value}`)
      .join("<br>");

    const html = `
      <h2>StellarYield Event: ${event}</h2>
      <p><strong>Vault:</strong> ${vaultName}</p>
      <p><strong>Event Type:</strong> ${event}</p>
      <hr>
      <p>${keyData}</p>
    `;

    try {
      await sendEmail({
        to: email,
        subject: `StellarYield Event: ${event}`,
        html,
      });
    } catch (err) {
      logger.error({ email, event, err }, "Failed to send email notification");
    }
  }

  /**
   * Return all active webhooks ordered by creation date (newest first).
   */
  async getWebhooks(): Promise<WebhookRow[]> {
    return query<WebhookRow>(
      `SELECT id, url, events, secret, consecutive_failures, channel, priority, fallback_channel
       FROM webhooks
       WHERE active = TRUE
       ORDER BY priority ASC, created_at DESC`,
    );
  }

  /**
   * Register a new webhook. Returns the created webhook row.
   */
  async createWebhook(
    url: string,
    events: string[],
    secret?: string,
    priority = 0,
    channel?: string,
  ): Promise<WebhookRow> {
    const rows = await query<WebhookRow>(
      `INSERT INTO webhooks (url, events, secret, priority, channel)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, url, events, secret, consecutive_failures, priority, fallback_channel, channel`,
      [url, events, secret ?? null, priority, channel ?? "webhook"],
    );
    return rows[0];
  }

  /**
   * Soft-delete a webhook by setting `active = FALSE`.
   * Returns `true` if a row was deactivated, `false` if not found.
   */
  async deleteWebhook(id: number): Promise<boolean> {
    const rows = await query<{ id: number }>(
      "UPDATE webhooks SET active = FALSE WHERE id = $1 AND active = TRUE RETURNING id",
      [id],
    );
    return rows.length > 0;
  }

  /**
   * Process due webhook retries. Selects entries that are due for retry,
   * re-delivers, and updates the delivery status.
   */
  async processRetries(): Promise<void> {
    const dueRows = await query<{
      id: number;
      webhook_id: number;
      payload: string;
      attempt: number;
      fallback_channel: number | null;
    }>(
      `SELECT wd.id, wd.webhook_id, wd.payload, wd.attempt, w.fallback_channel
       FROM webhook_deliveries wd
       JOIN webhooks w ON w.id = wd.webhook_id AND w.active = TRUE
       WHERE wd.next_retry_at <= NOW()
         AND wd.delivered_at IS NULL
         AND wd.attempt < 6
       ORDER BY wd.next_retry_at ASC
       LIMIT 50`,
    );

    for (const row of dueRows) {
      try {
        const webhookRows = await query<WebhookRow>(
          `SELECT id, url, events, secret, consecutive_failures, priority, fallback_channel, channel
           FROM webhooks WHERE id = $1`,
          [row.webhook_id],
        );
        if (webhookRows.length === 0) continue;
        const webhook = webhookRows[0];

        const deliveryResult = await this.deliver(webhook, row.payload);

        sseService.broadcastWebhookDelivery(webhook.id, {
          type: "delivery",
          attempt: row.attempt,
          statusCode: deliveryResult.statusCode,
          durationMs: deliveryResult.durationMs,
          success: deliveryResult.success,
        });

        if (deliveryResult.success) {
          await query(
            "UPDATE webhook_deliveries SET delivered_at = NOW() WHERE id = $1",
            [row.id],
          );
          if ((webhook.consecutive_failures ?? 0) > 0) {
            await query(`UPDATE webhooks SET consecutive_failures = 0 WHERE id = $1`, [webhook.id]);
          }
        } else {
          const nextAttempt = row.attempt + 1;
          const delaySeconds = Math.min(Math.pow(2, row.attempt) * 5, 3600);
          await query(
            `UPDATE webhook_deliveries
             SET attempt = $1, next_retry_at = NOW() + INTERVAL '1 second' * $2, last_error = $3
             WHERE id = $4`,
            [nextAttempt, delaySeconds, "non-2xx response", row.id],
          );
          await this.maybeEscalateToFallback(row, nextAttempt);
        }
      } catch (err) {
        const nextAttempt = row.attempt + 1;
        const delaySeconds = Math.min(Math.pow(2, row.attempt) * 5, 3600);
        await query(
          `UPDATE webhook_deliveries
           SET attempt = $1, next_retry_at = NOW() + INTERVAL '1 second' * $2, last_error = $3
           WHERE id = $4`,
          [nextAttempt, delaySeconds, String(err), row.id],
        );
        await this.maybeEscalateToFallback(row, nextAttempt);
      }
    }
  }

  /**
   * When a primary webhook has exhausted its retry budget (#219) and defines a
   * fallback channel, enqueue a single delivery attempt to that fallback
   * webhook with the original payload (#1024). No-op while retries remain or
   * when no fallback is configured.
   */
  private async maybeEscalateToFallback(
    row: { id: number; webhook_id: number; payload: string; fallback_channel: number | null },
    nextAttempt: number,
  ): Promise<void> {
    if (nextAttempt < MAX_DELIVERY_ATTEMPTS || row.fallback_channel == null) return;

    logger.warn(
      { webhookId: row.webhook_id, fallbackChannel: row.fallback_channel, deliveryId: row.id },
      "Primary webhook exhausted retries; escalating delivery to fallback channel",
    );

    await jobQueue.send("webhook-deliver", {
      webhookId: row.fallback_channel,
      payload: row.payload,
    });
  }

  /**
   * Send a test ping to a webhook endpoint (#666).
   * Returns delivery result metadata: delivered, statusCode, durationMs.
   */
  async testDeliver(
    webhook: WebhookRow,
  ): Promise<{ delivered: boolean; statusCode: number | null; durationMs: number }> {
    const payload = JSON.stringify({
      event: "test",
      timestamp: new Date().toISOString(),
      contractId: null,
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (webhook.secret) {
      const signature = createHmac("sha256", webhook.secret).update(payload).digest("hex");
      headers["X-StellarYield-Signature"] = `sha256=${signature}`;
    }

    const start = Date.now();
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });
      const durationMs = Date.now() - start;
      return { delivered: response.ok, statusCode: response.status, durationMs };
    } catch {
      const durationMs = Date.now() - start;
      return { delivered: false, statusCode: null, durationMs };
    }
  }

  /**
   * Verify an HMAC-SHA256 webhook signature (#664).
   * Computes sha256=HMAC(payload, secret) and performs constant-time comparison.
   */
  verifySignature(payload: string, signature: string, secret: string): boolean {
    const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Deliver a webhook payload. Returns delivery metrics.
   * Throws on network/SSRF errors.
   */
  private async deliver(
    webhook: WebhookRow,
    payload: string,
  ): Promise<{ success: boolean; statusCode: number | null; durationMs: number }> {
    const start = Date.now();

    try {
      await validateWebhookUrl(webhook.url);
    } catch (err) {
      logger.warn(
        { webhookId: webhook.id, url: webhook.url, err },
        "Webhook URL failed SSRF check at delivery; skipping",
      );
      const durationMs = Date.now() - start;
      return { success: false, statusCode: null, durationMs };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (webhook.secret) {
      const signature = createHmac("sha256", webhook.secret).update(payload).digest("hex");
      headers["X-StellarYield-Signature"] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });

      const durationMs = Date.now() - start;

      if (response.status >= 300 && response.status < 400) {
        logger.warn(
          { webhookId: webhook.id, url: webhook.url, status: response.status },
          "Webhook delivery returned redirect; rejected for SSRF protection",
        );
        return { success: false, statusCode: response.status, durationMs };
      }

      if (!response.ok) {
        logger.warn(
          { webhookId: webhook.id, url: webhook.url, status: response.status },
          "Webhook delivery returned non-2xx status",
        );
        return { success: false, statusCode: response.status, durationMs };
      }

      return { success: true, statusCode: response.status, durationMs };
    } catch (err) {
      logger.warn({ webhookId: webhook.id, url: webhook.url, err }, "Webhook delivery failed");
      throw err;
    }
  }

  async registerWebhook(url: string, events: string[], secret?: string): Promise<void> {
    await query("INSERT INTO webhooks (url, events, secret) VALUES ($1, $2, $3)", [
      url,
      events,
      secret ?? null,
    ]);
  }
}