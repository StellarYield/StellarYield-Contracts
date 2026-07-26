import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("./db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

import { createApp } from "./app.js";

const app = createApp();

describe("Security headers (helmet) - #524", () => {
  beforeAll(() => {
    // ensure pool mock is in place before requests
  });

  it("GET /health returns X-Content-Type-Options: nosniff", async () => {
    const { default: supertest } = await import("supertest");
    const res = await supertest(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("GET /health returns X-Frame-Options: SAMEORIGIN or DENY", async () => {
    const { default: supertest } = await import("supertest");
    const res = await supertest(app).get("/health");
    // helmet sets SAMEORIGIN by default; both satisfy the security requirement
    expect(res.headers["x-frame-options"]).toMatch(/SAMEORIGIN|DENY/);
  });
});

describe("Request body size limit - #749", () => {
  it("rejects a JSON body larger than the configured limit with 413", async () => {
    const { default: supertest } = await import("supertest");
    const oversized = { data: "x".repeat(200 * 1024) };
    const res = await supertest(app)
      .post("/api/v1/webhooks/verify-signature")
      .send(oversized);
    expect(res.status).toBe(413);
  });

  it("accepts a JSON body within the configured limit", async () => {
    const { default: supertest } = await import("supertest");
    const res = await supertest(app)
      .post("/api/v1/webhooks/verify-signature")
      .send({ data: "x".repeat(1024) });
    expect(res.status).not.toBe(413);
  });
});

describe("GraphQL schema export - #773", () => {
  it("GET /api/graphql/schema returns parseable SDL", async () => {
    const { default: supertest } = await import("supertest");
    const { buildSchema } = await import("graphql");
    const res = await supertest(app).get("/api/graphql/schema");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/graphql/);
    expect(() => buildSchema(res.text)).not.toThrow();
  });
});

describe("Apollo GraphQL server - #765", () => {
  it("POST /api/graphql with { query: \"{ health }\" } returns { data: { health: \"ok\" } }", async () => {
    const { default: supertest } = await import("supertest");
    const res = await supertest(app)
      .post("/api/graphql")
      .send({ query: "{ health }" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { health: "ok" } });
  });
});
