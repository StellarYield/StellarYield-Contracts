import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { responseSizeLimit } from "./responseSizeLimit.js";

describe("responseSizeLimit middleware (#953)", () => {
  it("allows responses under the size limit", async () => {
    const app = express();
    app.use(responseSizeLimit(1)); // 1 MB limit
    app.get("/small", (_req, res) => {
      res.json({ message: "hello" });
    });

    const res = await request(app).get("/small");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "hello" });
  });

  it("aborts response with HTTP 500 when limit is exceeded via write/end", async () => {
    const app = express();
    app.use(responseSizeLimit(0.001)); // ~1 KB limit (1024 bytes)
    app.get("/large", (_req, res) => {
      const largeData = "x".repeat(2000);
      res.send(largeData);
    });

    const res = await request(app).get("/large");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "InternalServerError",
      message: "Response size limit exceeded",
    });
  });
});
