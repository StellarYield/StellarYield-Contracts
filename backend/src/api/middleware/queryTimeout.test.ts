import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import express from "express";
import supertest from "supertest";
import { config } from "../../config.js";
import { queryTimeoutMiddleware } from "./queryTimeout.js";

describe("queryTimeoutMiddleware", () => {
  it("passes the configured timeout to the next handler without affecting a fast request", async () => {
    const app = express();
    app.use(queryTimeoutMiddleware());
    app.get("/fast", (req, res) => {
      res.json({ ok: true, queryTimeoutMs: req.queryTimeoutMs });
    });

    const res = await supertest(app).get("/fast");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, queryTimeoutMs: config.db.queryTimeoutMs });
  });

  it("does not leave a timer pending when it forwards the request", () => {
    vi.useFakeTimers();
    try {
      const req = {} as Request;
      const next = vi.fn();

      queryTimeoutMiddleware()(req, {} as Response, next);

      expect(req.queryTimeoutMs).toBe(config.db.queryTimeoutMs);
      expect(next).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
