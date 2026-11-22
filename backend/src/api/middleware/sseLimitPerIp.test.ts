import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { getUnauthenticatedClientsForIp } = vi.hoisted(() => ({
  getUnauthenticatedClientsForIp: vi.fn(),
}));

vi.mock("../../services/sse.js", () => ({
  sseService: { getUnauthenticatedClientsForIp },
}));

import { sseLimitPerIp } from "./sseLimitPerIp.js";

const MAX = 5;

function buildApp() {
  const app = express();
  app.use(sseLimitPerIp());
  app.get("/api/v1/events", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("sseLimitPerIp middleware (#1390)", () => {
  beforeEach(() => {
    getUnauthenticatedClientsForIp.mockReset();
  });

  it("allows a connection when the IP is under the limit", async () => {
    getUnauthenticatedClientsForIp.mockReturnValue(MAX - 1);

    const res = await request(buildApp()).get("/api/v1/events");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects the connection that would exceed the limit with 429 and Retry-After", async () => {
    getUnauthenticatedClientsForIp.mockReturnValue(MAX);

    const res = await request(buildApp()).get("/api/v1/events");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body).toMatchObject({
      error: "TooManyRequests",
      message: expect.stringContaining(`${MAX}`),
    });
  });

  it("frees a slot when a client disconnects — a subsequent request from the same IP is accepted", async () => {
    // First call: at the limit → rejected.
    getUnauthenticatedClientsForIp.mockReturnValueOnce(MAX);
    const app = buildApp();

    const first = await request(app).get("/api/v1/events");
    expect(first.status).toBe(429);

    // Client disconnects; count drops below the limit.
    getUnauthenticatedClientsForIp.mockReturnValueOnce(MAX - 1);

    const second = await request(app).get("/api/v1/events");
    expect(second.status).toBe(200);
  });

  it("bypasses the limit for authenticated requests (apiKey present)", async () => {
    // Even at the limit, an authenticated request should pass through.
    getUnauthenticatedClientsForIp.mockReturnValue(MAX);

    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = "test-key";
      next();
    });
    app.use(sseLimitPerIp());
    app.get("/api/v1/events", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/v1/events");
    expect(res.status).toBe(200);
  });
});
