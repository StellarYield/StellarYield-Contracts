import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({ adminIpAllowlist: [] as string[] }));
const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock("../../config.js", () => ({ config: mockConfig }));
vi.mock("../../logger.js", () => ({ logger: mockLogger }));

import { ipAllowlist } from "./ipAllowlist.js";

function makeReqRes(opts: { ip?: string; forwardedFor?: string; remoteAddress?: string }) {
  const req = {
    ip: opts.ip,
    headers: opts.forwardedFor !== undefined ? { "x-forwarded-for": opts.forwardedFor } : {},
    socket: { remoteAddress: opts.remoteAddress },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

function expectAllowed(ctx: ReturnType<typeof makeReqRes>) {
  expect(ctx.next).toHaveBeenCalledTimes(1);
  expect(ctx.res.status).not.toHaveBeenCalled();
}

function expectDenied(ctx: ReturnType<typeof makeReqRes>) {
  expect(ctx.next).not.toHaveBeenCalled();
  expect(ctx.res.status).toHaveBeenCalledWith(403);
  expect(ctx.res.json).toHaveBeenCalledWith({ error: "Forbidden", message: "IP not allowed" });
}

describe("ipAllowlist middleware (#1384)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.adminIpAllowlist = [];
  });

  describe("empty allowlist", () => {
    it("passes every request through when no entries are configured", () => {
      const mw = ipAllowlist();
      const ctx = makeReqRes({ ip: "203.0.113.50" });

      mw(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("allowed IPs", () => {
    it("allows an exact IP match", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.5"];
      const ctx = makeReqRes({ ip: "10.0.0.5" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("allows an IP inside a CIDR range", () => {
      mockConfig.adminIpAllowlist = ["192.168.1.0/24"];
      const ctx = makeReqRes({ ip: "192.168.1.200" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("allows an IP matching any one of several entries", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.0/8", "172.16.0.1"];
      const ctx = makeReqRes({ ip: "172.16.0.1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("allows any IPv4 address with a /0 entry", () => {
      mockConfig.adminIpAllowlist = ["0.0.0.0/0"];
      const ctx = makeReqRes({ ip: "8.8.8.8" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("uses the first x-forwarded-for address when present", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.5"];
      const ctx = makeReqRes({ ip: "203.0.113.9", forwardedFor: "10.0.0.5, 203.0.113.9" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("falls back to socket.remoteAddress when req.ip is undefined", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.5"];
      const ctx = makeReqRes({ remoteAddress: "10.0.0.5" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });
  });

  describe("denied IPs", () => {
    it("denies an IP not in the allowlist with 403 and logs a warning", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.5"];
      const ctx = makeReqRes({ ip: "10.0.0.6" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { ip: "10.0.0.6" },
        "Blocked admin request from disallowed IP",
      );
    });

    it("denies an IP just outside a CIDR range", () => {
      mockConfig.adminIpAllowlist = ["192.168.1.0/24"];
      const ctx = makeReqRes({ ip: "192.168.2.1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
    });

    it("denies based on x-forwarded-for even when req.ip is allowed", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.5"];
      const ctx = makeReqRes({ ip: "10.0.0.5", forwardedFor: "203.0.113.9" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
    });

    it("denies a malformed client IP", () => {
      mockConfig.adminIpAllowlist = ["0.0.0.0/0"];
      const ctx = makeReqRes({ ip: "not-an-ip" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
    });

    it("ignores allowlist entries with an invalid prefix length", () => {
      mockConfig.adminIpAllowlist = ["10.0.0.0/33"];
      const ctx = makeReqRes({ ip: "10.0.0.1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
    });

    it("denies a non-mapped IPv6 address", () => {
      mockConfig.adminIpAllowlist = ["0.0.0.0/0"];
      const ctx = makeReqRes({ ip: "2001:db8::1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
    });
  });

  describe("IPv6-mapped IPv4 addresses", () => {
    it("normalises ::ffff:a.b.c.d and allows it against an exact IPv4 entry", () => {
      mockConfig.adminIpAllowlist = ["127.0.0.1"];
      const ctx = makeReqRes({ ip: "::ffff:127.0.0.1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("normalises ::ffff:a.b.c.d and matches it against a CIDR entry", () => {
      mockConfig.adminIpAllowlist = ["10.1.0.0/16"];
      const ctx = makeReqRes({ ip: "::ffff:10.1.42.7" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });

    it("denies a mapped address whose IPv4 part is outside the allowlist", () => {
      mockConfig.adminIpAllowlist = ["10.1.0.0/16"];
      const ctx = makeReqRes({ ip: "::ffff:10.2.0.1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectDenied(ctx);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { ip: "10.2.0.1" },
        "Blocked admin request from disallowed IP",
      );
    });

    it("treats IPv6 loopback ::1 as 127.0.0.1", () => {
      mockConfig.adminIpAllowlist = ["127.0.0.1/32"];
      const ctx = makeReqRes({ ip: "::1" });

      ipAllowlist()(ctx.req, ctx.res, ctx.next);

      expectAllowed(ctx);
    });
  });
});
