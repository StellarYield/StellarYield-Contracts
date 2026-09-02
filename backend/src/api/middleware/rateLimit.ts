import rateLimit from "express-rate-limit";
import { config } from "../../config.js";

export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.public,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "TooManyRequests", message: "Rate limit exceeded" },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.auth,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "TooManyRequests", message: "Rate limit exceeded" },
});

export const simulateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.simulate,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.set("Retry-After", "60");
    res.status(429).json({ error: "TooManyRequests", message: "Rate limit exceeded" });
  },
});

export function perKeyLimiter(overrideLimit: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: overrideLimit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      return req.apiKey?.label ?? req.ip ?? "unknown";
    },
    handler: (_req, res) => {
      res.set("Retry-After", "60");
      res.status(429).json({ error: "TooManyRequests", message: "Rate limit exceeded" });
    },
  });
}
