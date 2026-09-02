import { describe, it, expect, vi } from "vitest";
import express from "express";
import compression from "compression";
import supertest from "supertest";

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  },
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

// Mirror of the pipeline wired up in app.ts (#948).
function buildApp() {
  const app = express();
  app.use((_req, res, next) => {
    res.vary("Accept-Encoding");
    next();
  });
  app.use(compression({ threshold: 1024 }));
  app.get("/large", (_req, res) => {
    res.type("application/json").send(JSON.stringify({ blob: "x".repeat(4096) }));
  });
  app.get("/small", (_req, res) => {
    res.type("application/json").send(JSON.stringify({ ok: true }));
  });
  return app;
}

describe("Response compression (#948)", () => {
  const app = buildApp();

  it("compresses payloads larger than 1 KB when the client accepts gzip", async () => {
    const res = await supertest(app).get("/large").set("Accept-Encoding", "gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("does not compress responses smaller than 1 KB", async () => {
    const res = await supertest(app).get("/small").set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("does not compress when the client does not accept gzip", async () => {
    const res = await supertest(app).get("/large").set("Accept-Encoding", "identity");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("sets Vary: Accept-Encoding regardless of payload size", async () => {
    const res = await supertest(app).get("/small");
    expect(String(res.headers["vary"])).toMatch(/Accept-Encoding/i);
  });
});

describe("Response compression wired into the app (#948)", () => {
  it("sets Vary: Accept-Encoding on API responses", async () => {
    const { createApp } = await import("../../app.js");
    const res = await supertest(createApp()).get("/health");
    expect(String(res.headers["vary"])).toMatch(/Accept-Encoding/i);
  });
});
