import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { cacheControl } from "./cacheControl.js";

describe("cacheControl middleware (#957)", () => {
  const customConfig = {
    "/api/v1/vaults": 60,
    "/api/v1/yields": 60,
  };

  it("sets Cache-Control header matching config for configured GET routes", async () => {
    const app = express();
    app.use(cacheControl(customConfig));
    app.get("/api/v1/vaults", (_req, res) => {
      res.json({ vaults: [] });
    });

    const res = await request(app).get("/api/v1/vaults");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("always sets Cache-Control: no-store for mutation endpoints (POST, PUT, PATCH, DELETE)", async () => {
    const app = express();
    app.use(cacheControl(customConfig));
    app.post("/api/v1/admin/vaults/reindex", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).post("/api/v1/admin/vaults/reindex");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("defaults to Cache-Control: no-store for unconfigured GET routes", async () => {
    const app = express();
    app.use(cacheControl(customConfig));
    app.get("/unconfigured", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/unconfigured");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
