import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload, TokenExpiredError } from "jsonwebtoken";
import { query } from "../../db/index.js";
import { logger } from "../../logger.js";
import { config } from "../../config.js";
import { incrementCounter } from "../../cache/redis.js";
import { logSecurityEvent } from "../../services/securityLogger.js";

interface ApiKey {
  id: number;
  role: string;
  label: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  active: boolean;
  allowedMethods: string[] | null;
  rateLimitOverride?: number | null;
  allowedCidrs: string[] | null;
}

interface AdminSessionClaims extends JwtPayload {
  role?: string;
  type?: string;
  sub?: string;
  allowedMethods?: string[] | null;
}

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: ApiKey;
  }
}

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

const AUTH_FAIL_LOCKOUT_THRESHOLD = 20;
const AUTH_FAIL_LOCKOUT_TTL_SECONDS = 15 * 60;

async function lookupApiKeyByPlaintext(plaintext: string): Promise<ApiKey | null> {
  const keyHash = createHash("sha256").update(plaintext).digest("hex");

  try {
    const rows = (await query<ApiKey>(
      `SELECT id, role, label, expires_at AS "expiresAt", last_used_at AS "lastUsedAt", active,
              allowed_methods AS "allowedMethods", rate_limit_override AS "rateLimitOverride"
       FROM api_keys WHERE key_hash = $1`,
      [keyHash],
    )) ?? [];
    return rows[0] ?? null;
function parseIpv4(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [rangeIp, bitsStr] = cidr.split("/");
  const bits = bitsStr ? parseInt(bitsStr, 10) : 32;

  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipNum = parseIpv4(ip);
  const rangeNum = parseIpv4(rangeIp);

  if (ipNum === -1 || rangeNum === -1) return false;

  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function isIpAllowedByCidrs(ip: string, allowedCidrs: string[] | null): boolean {
  if (!allowedCidrs || allowedCidrs.length === 0) return true;
  return allowedCidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

async function lookupApiKeyCidrsById(keyId: number): Promise<string[] | null> {
  try {
    const rows = await query<{ allowed_cidrs: string[] | null }>(
      "SELECT allowed_cidrs FROM api_keys WHERE id = $1",
      [keyId],
    );
    return rows[0]?.allowed_cidrs ?? null;
  } catch {
    return null;
  }
}

/**
 * Record that a key was just used for a successful authentication (#933).
 *
 * Deliberately not awaited: the timestamp is bookkeeping, so a slow or failing
 * write must neither add latency to nor fail an otherwise valid request. The
 * update is skipped when this key was already touched earlier in the same
 * request, which happens on routes that layer a per-route role check on top of
 * the router-level guard.
 */
function touchLastUsed(req: Request, apiKey: ApiKey): void {
  if (req.apiKey?.id === apiKey.id) return;

  void query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [apiKey.id]).catch(
    (err: unknown) => {
      logger.warn({ err, keyId: apiKey.id }, "Failed to update api_keys.last_used_at");
    },
  );
}

/**
 * Per-key HTTP method scope (#935): a NULL/absent list means every method is
 * allowed, which is how every pre-existing key behaves.
 */
function isMethodAllowed(apiKey: Pick<ApiKey, "allowedMethods">, method: string): boolean {
  if (!apiKey.allowedMethods) return true;
  return apiKey.allowedMethods.some((allowed) => allowed.toUpperCase() === method.toUpperCase());
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

async function lookupApiKeyByPlaintext(plaintext: string): Promise<ApiKey | null> {
  const keyHash = createHash("sha256").update(plaintext).digest("hex");

  try {
    const rows = (await query<ApiKey>(
      `SELECT id, role, label, expires_at AS "expiresAt", last_used_at AS "lastUsedAt", active,
              allowed_methods AS "allowedMethods", rate_limit_override AS "rateLimitOverride"
              allowed_methods AS "allowedMethods", allowed_cidrs AS "allowedCidrs"
       FROM api_keys WHERE key_hash = $1`,
      [keyHash],
    )) ?? [];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function verifyAdminSession(token: string): ApiKey | null {
  const secret = config.adminJwtSecret;
  const claims = jwt.verify(token, secret) as AdminSessionClaims;

  if (claims.type !== "admin_session" || !claims.role) {
    return null;
  }

  const expiresAt = typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;

  return {
    id: Number(claims.sub ?? -1) || -1,
    role: String(claims.role),
    label: typeof claims.sub === "string" && claims.sub ? `session:${claims.sub}` : "admin-session",
    expiresAt,
    // Session tokens are minted from an API key; the key itself was stamped at
    // login, so the derived session carries no last-used timestamp of its own.
    lastUsedAt: null,
    // A session can only exist because an active key authenticated the login.
    active: true,
    allowedMethods: Array.isArray(claims.allowedMethods) ? claims.allowedMethods : null,
    // CIDR restrictions are not carried in the JWT; they are checked via the
    // underlying API key lookup when a raw key is presented. For session tokens,
    // the CIDR check was already applied at login time.
    allowedCidrs: null,
  };
}

export function createAdminSessionToken(
  apiKey: Pick<ApiKey, "id" | "role" | "label" | "allowedMethods">,
): string {
  const secret = config.adminJwtSecret;
  const expiresInMinutes = config.adminSessionExpiryMinutes;

  return jwt.sign(
    {
      sub: String(apiKey.id),
      role: apiKey.role,
      type: "admin_session",
      label: apiKey.label ?? null,
      allowedMethods: apiKey.allowedMethods ?? null,
    },
    secret,
    { expiresIn: `${expiresInMinutes}m` },
  );
}

export function refreshAdminSessionToken(token: string): string {
  const secret = config.adminJwtSecret;
  const claims = jwt.verify(token, secret) as AdminSessionClaims;

  if (claims.type !== "admin_session" || !claims.role) {
    throw new Error("Invalid session token");
  }

  return jwt.sign(
    {
      sub: claims.sub ?? "admin-session",
      role: claims.role,
      type: "admin_session",
      label: claims.label ?? null,
      allowedMethods: claims.allowedMethods ?? null,
    },
    secret,
    { expiresIn: `${config.adminSessionExpiryMinutes}m` },
  );
}

export function requireApiKey(options?: { role?: string; minRole?: "readonly" | "admin" }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);

    const lockoutCount = await incrementCounter(`auth_fail:${ip}`, AUTH_FAIL_LOCKOUT_TTL_SECONDS);
    if (lockoutCount !== null && lockoutCount > AUTH_FAIL_LOCKOUT_THRESHOLD) {
      await logSecurityEvent("IP_LOCKOUT", { ipAddress: ip, path: req.path });
      res.status(429).json({ error: "TooManyRequests", message: "IP locked out due to too many failed attempts" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized", message: "Missing API key" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const sessionApiKey = verifyAdminSession(token);
      if (sessionApiKey) {
        if (sessionApiKey.expiresAt && sessionApiKey.expiresAt.getTime() <= Date.now()) {
          logger.info({
            event: "auth_attempt",
            success: false,
            ip,
            keyLabel: sessionApiKey.label,
            path: req.path,
            method: req.method,
            reason: "expired",
          });
          res.status(401).json({ error: "Unauthorized", message: "JWT expired" });
          return;
        }

        if (!isMethodAllowed(sessionApiKey, req.method)) {
          logger.info({
            event: "auth_attempt",
            success: false,
            ip,
            keyLabel: sessionApiKey.label,
            path: req.path,
            method: req.method,
            reason: "method_not_allowed",
          });
          res.status(403).json({
            error: "Forbidden",
            message: `API key is not permitted to use the ${req.method} method`,
          });
          return;
        }

        if (options?.role && sessionApiKey.role !== options.role) {
          logger.info({
            event: "auth_attempt",
            success: false,
            ip,
            keyLabel: sessionApiKey.label,
            path: req.path,
            method: req.method,
            reason: "insufficient_permissions",
          });
          res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
          return;
        }

        if (options?.minRole === "readonly" && sessionApiKey.role !== "admin") {
          if (sessionApiKey.role !== "readonly" || !READ_ONLY_METHODS.has(req.method)) {
            logger.info({
              event: "auth_attempt",
              success: false,
              ip,
              keyLabel: sessionApiKey.label,
              path: req.path,
              method: req.method,
              reason: "insufficient_permissions",
            });
            res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
            return;
          }
        }

        // Per-key IP CIDR restriction (#928): look up the underlying key's
        // allowed_cidrs and reject if the request IP is not in the list.
        if (sessionApiKey.id > 0) {
          const allowedCidrs = await lookupApiKeyCidrsById(sessionApiKey.id);
          if (!isIpAllowedByCidrs(ip, allowedCidrs)) {
            logger.info({
              event: "auth_attempt",
              success: false,
              ip,
              keyLabel: sessionApiKey.label,
              path: req.path,
              method: req.method,
              reason: "ip_not_allowed",
            });
            res.status(403).json({ error: "Forbidden", message: "IP not allowed by key CIDR restriction" });
            return;
          }
        }

        logger.info({
          event: "auth_attempt",
          success: true,
          ip,
          keyLabel: sessionApiKey.label,
          path: req.path,
          method: req.method,
        });

        req.apiKey = sessionApiKey;
        next();
        return;
      }
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        logger.info({
          event: "auth_attempt",
          success: false,
          ip,
          keyLabel: null,
          path: req.path,
          method: req.method,
          reason: "expired",
        });
        res.status(401).json({ error: "Unauthorized", message: "JWT expired" });
        return;
      }
    }

    const apiKey = await lookupApiKeyByPlaintext(token);

    if (!apiKey) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, path: req.path, details: { reason: "key_not_found" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: null,
        path: req.path,
        method: req.method,
        reason: "key_not_found",
      });
      res.status(403).json({ error: "Forbidden", message: "Invalid API key" });
      return;
    }

    // Keys deactivated by the inactivity sweep are rejected outright (#934).
    if (apiKey.active === false) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "deactivated" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "deactivated",
      });
      res.status(403).json({ error: "Forbidden", message: "API key has been deactivated" });
      return;
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "expired" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "expired",
      });
      res.status(401).json({ error: "Unauthorized", message: "API key has expired" });
      return;
    }

    if (!isMethodAllowed(apiKey, req.method)) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "method_not_allowed" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "method_not_allowed",
      });
      res.status(403).json({
        error: "Forbidden",
        message: `API key is not permitted to use the ${req.method} method`,
      });
      return;
    }

    if (options?.role && apiKey.role !== options.role) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "insufficient_permissions" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "insufficient_permissions",
      });
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }

    if (options?.minRole === "readonly" && apiKey.role !== "admin") {
      if (apiKey.role !== "readonly" || !READ_ONLY_METHODS.has(req.method)) {
        await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "insufficient_permissions" } });
        logger.info({
          event: "auth_attempt",
          success: false,
          ip,
          keyLabel: apiKey.label,
          path: req.path,
          method: req.method,
          reason: "insufficient_permissions",
        });
        res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
        return;
      }
    }

    // Per-key IP CIDR restriction (#928): reject if the request IP is not in
    // the key's allowed_cidrs list. A NULL/empty list means any IP is allowed.
    if (!isIpAllowedByCidrs(ip, apiKey.allowedCidrs)) {
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "ip_not_allowed",
      });
      res.status(403).json({ error: "Forbidden", message: "IP not allowed by key CIDR restriction" });
      return;
    }

    logger.info({
      event: "auth_attempt",
      success: true,
      ip,
      keyLabel: apiKey.label,
      path: req.path,
      method: req.method,
    });

    touchLastUsed(req, apiKey);

    req.apiKey = apiKey;
    next();
  };
}
