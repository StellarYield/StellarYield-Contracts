import { query } from "../db/index.js";

export type SecurityEventType =
  | "AUTH_FAILURE"
  | "RATE_LIMIT_EXCEEDED"
  | "IP_LOCKOUT"
  | "IP_NOT_ALLOWED";

export async function logSecurityEvent(
  eventType: SecurityEventType,
  options: {
    ipAddress?: string | null;
    apiKeyLabel?: string | null;
    path?: string;
    details?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO security_events (event_type, ip_address, api_key_label, path, details, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        eventType,
        options.ipAddress ?? null,
        options.apiKeyLabel ?? null,
        options.path ?? null,
        options.details ? JSON.stringify(options.details) : null,
      ],
    );
  } catch {
    // Security logging is best-effort; never fail the request
  }
}
