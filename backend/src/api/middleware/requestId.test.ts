import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: {
    child: vi.fn((bindings: Record<string, unknown>) => ({ bindings })),
  },
}));

import { requestId } from "./requestId.js";
import { logger } from "../../logger.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeReqRes() {
  const req = { headers: {} } as any;
  const res = { setHeader: vi.fn() } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("requestId middleware (#694)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets an X-Request-ID header matching UUID v4 format", () => {
    const { req, res, next } = makeReqRes();

    requestId(req, res, next);

    expect(req.requestId).toMatch(UUID_V4_REGEX);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", req.requestId);
    expect(next).toHaveBeenCalledOnce();
  });

  it("attaches the requestId to the pino logger for the request", () => {
    const { req, res, next } = makeReqRes();

    requestId(req, res, next);

    expect(logger.child).toHaveBeenCalledWith({ requestId: req.requestId });
    expect(req.log).toBeDefined();
  });

  it("assigns different requestIds to two simultaneous requests", () => {
    const first = makeReqRes();
    const second = makeReqRes();

    requestId(first.req, first.res, first.next);
    requestId(second.req, second.res, second.next);

    expect(first.req.requestId).toMatch(UUID_V4_REGEX);
    expect(second.req.requestId).toMatch(UUID_V4_REGEX);
    expect(first.req.requestId).not.toBe(second.req.requestId);
  });

  describe("X-Request-ID echo (#945)", () => {
    it("echoes a valid client-supplied UUID v4 in X-Request-ID header", () => {
      const { req, res, next } = makeReqRes();
      const clientUuid = "a1b2c3d4-e5f6-4789-abcd-ef0123456789";
      req.headers = { "x-request-id": clientUuid };

      requestId(req, res, next);

      expect(req.requestId).toBe(clientUuid);
      expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", clientUuid);
      expect(next).toHaveBeenCalledOnce();
    });

    it("ignores non-UUID value and generates server UUID", () => {
      const { req, res, next } = makeReqRes();
      req.headers = { "x-request-id": "not-a-uuid" };

      requestId(req, res, next);

      expect(req.requestId).toMatch(UUID_V4_REGEX);
      expect(req.requestId).not.toBe("not-a-uuid");
      expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", req.requestId);
      expect(next).toHaveBeenCalledOnce();
    });

    it("generates server UUID when X-Request-ID header is absent", () => {
      const { req, res, next } = makeReqRes();
      req.headers = {};

      requestId(req, res, next);

      expect(req.requestId).toMatch(UUID_V4_REGEX);
      expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", req.requestId);
      expect(next).toHaveBeenCalledOnce();
    });

    it("ignores UUID v1/v3/v5 and generates server UUID v4", () => {
      const { req, res, next } = makeReqRes();
      // UUID v1 example (note the '1' in the third group)
      req.headers = { "x-request-id": "a1b2c3d4-e5f6-11eb-b8bc-0242ac130003" };

      requestId(req, res, next);

      expect(req.requestId).toMatch(UUID_V4_REGEX);
      expect(req.requestId).not.toBe("a1b2c3d4-e5f6-11eb-b8bc-0242ac130003");
      expect(next).toHaveBeenCalledOnce();
    });
  });
});
