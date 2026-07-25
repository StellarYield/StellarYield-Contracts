import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

vi.mock("../../config.js", () => ({ config: { internalSecret: "test-internal-secret" } }));

async function getTestContext() {
  const { internalAuth } = await import("./internalAuth.js");
  return { internalAuth };
}

function sign(method: string, url: string, timestamp: string, body: unknown) {
  const payload = `${method}${url}${timestamp}${body && Object.keys(body as object).length > 0 ? JSON.stringify(body) : ""}`;
  return createHmac("sha256", "test-internal-secret").update(payload).digest("hex");
}

function makeReqRes(opts: {
  method?: string;
  originalUrl?: string;
  body?: unknown;
  signature?: string;
  timestamp?: string;
}) {
  const req = {
    method: opts.method ?? "GET",
    originalUrl: opts.originalUrl ?? "/internal/ping",
    body: opts.body ?? {},
    headers: {
      ...(opts.signature !== undefined ? { "x-internal-signature": opts.signature } : {}),
      ...(opts.timestamp !== undefined ? { "x-internal-timestamp": opts.timestamp } : {}),
    },
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("internalAuth middleware (#752)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the signature header is missing", async () => {
    const { internalAuth } = await getTestContext();
    const { req, res, next } = makeReqRes({ timestamp: String(Date.now()) });

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the timestamp header is missing", async () => {
    const { internalAuth } = await getTestContext();
    const { req, res, next } = makeReqRes({ signature: "deadbeef" });

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the timestamp is more than 30 seconds old (replay protection)", async () => {
    const { internalAuth } = await getTestContext();
    const timestamp = String(Date.now() - 31_000);
    const signature = sign("GET", "/internal/ping", timestamp, {});
    const { req, res, next } = makeReqRes({ signature, timestamp });

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Stale or invalid timestamp",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature does not match", async () => {
    const { internalAuth } = await getTestContext();
    const timestamp = String(Date.now());
    const { req, res, next } = makeReqRes({ signature: "not-the-right-signature", timestamp });

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Invalid signature",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() for a valid signature with a recent timestamp", async () => {
    const { internalAuth } = await getTestContext();
    const timestamp = String(Date.now());
    const signature = sign("GET", "/internal/ping", timestamp, {});
    const { req, res, next } = makeReqRes({ signature, timestamp });

    internalAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("includes the request body in the signed payload", async () => {
    const { internalAuth } = await getTestContext();
    const timestamp = String(Date.now());
    const body = { foo: "bar" };
    const signature = sign("POST", "/internal/ping", timestamp, body);
    const { req, res, next } = makeReqRes({ method: "POST", signature, timestamp, body });

    internalAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
