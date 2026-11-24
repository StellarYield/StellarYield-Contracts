import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { normalizeTrailingSlash } from "./trailingSlash.js";

function buildApp() {
  const app = express();
  app.use(normalizeTrailingSlash);
  app.get("/api/v1/vaults", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.json({ root: true }));
  return app;
}

describe("normalizeTrailingSlash middleware (#1391)", () => {
  it("rewrites a trailing-slash GET path to the canonical path without redirecting", async () => {
    const res = await request(buildApp()).get("/api/v1/vaults/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("passes through a path that has no trailing slash unchanged", async () => {
    const res = await request(buildApp()).get("/api/v1/vaults");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("does not redirect the root path", async () => {
    const res = await request(buildApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: true });
  });

  it("preserves the query string when rewriting a trailing-slash GET path", async () => {
    const app = express();
    app.use(normalizeTrailingSlash);
    app.get("/api/v1/vaults", (req, res) => res.json({ query: req.query }));

    const res = await request(app).get("/api/v1/vaults/?page=2&limit=10");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: { page: "2", limit: "10" } });
  });

  it("issues a 308 redirect for non-GET methods with a trailing slash, preserving the query string", async () => {
    const app = express();
    app.use(normalizeTrailingSlash);
    app.post("/api/v1/vaults", (_req, res) => res.json({ ok: true }));

    const res = await request(app).post("/api/v1/vaults/?dry=true").send({});
    expect(res.status).toBe(308);
    expect(res.headers["location"]).toBe("/api/v1/vaults?dry=true");
  });
});
