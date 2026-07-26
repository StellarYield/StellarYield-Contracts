import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

describe("Apollo GraphQL Playground/Sandbox landing page - #765", () => {
  const originalNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    process.env["NODE_ENV"] = originalNodeEnv;
  });

  it("serves the interactive landing page for GET /api/graphql in development", async () => {
    vi.resetModules();
    process.env["NODE_ENV"] = "development";

    const { default: supertest } = await import("supertest");
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await supertest(app).get("/api/graphql").set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("does not serve the landing page for GET /api/graphql outside development", async () => {
    vi.resetModules();
    process.env["NODE_ENV"] = "production";

    const { default: supertest } = await import("supertest");
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await supertest(app).get("/api/graphql").set("Accept", "text/html");

    expect(res.headers["content-type"]).not.toMatch(/text\/html/);
  });
});
