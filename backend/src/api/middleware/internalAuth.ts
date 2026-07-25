import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../../config.js";

const MAX_TIMESTAMP_SKEW_MS = 30_000;

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Verifies the X-Internal-Signature / X-Internal-Timestamp headers on
 * service-to-service requests (mounted under /internal/).
 * Signature = HMAC-SHA256(method + path + timestamp + body, INTERNAL_SECRET).
 */
export function internalAuth(req: Request, res: Response, next: NextFunction) {
  const signature = req.headers["x-internal-signature"];
  const timestamp = req.headers["x-internal-timestamp"];

  if (typeof signature !== "string" || typeof timestamp !== "string") {
    res.status(401).json({ error: "Unauthorized", message: "Missing internal signature" });
    return;
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) {
    res.status(401).json({ error: "Unauthorized", message: "Stale or invalid timestamp" });
    return;
  }

  const body = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : "";
  const payload = `${req.method}${req.originalUrl}${timestamp}${body}`;
  const expected = createHmac("sha256", config.internalSecret).update(payload).digest("hex");

  if (!safeEqualHex(expected, signature)) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid signature" });
    return;
  }

  next();
}
