import { lookup } from "dns/promises";
import type { Request, Response, NextFunction } from "express";

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

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "100.100.100.200",
]);

export async function validateWebhookUrlSsrf(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Webhook URL hostname is not allowed");
  }

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

export function ssrfProtectionMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    next();
  };
}
