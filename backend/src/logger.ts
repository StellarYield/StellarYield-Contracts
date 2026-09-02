import pino from "pino";
import { config } from "./config.js";

const SENSITIVE_FIELDS = new Set(["key", "secret", "password", "authorization", "token"]);

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv !== "production"
      ? { target: "pino-pretty" }
      : undefined,
  redact: {
    paths: Array.from(SENSITIVE_FIELDS).map((f) => `*.${f}`),
    remove: true,
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
  },
});

export function maskSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...obj };
  for (const key of Object.keys(masked)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      masked[key] = "[REDACTED]";
    }
  }
  return masked;
}
