import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { deprecate } from "./deprecation.js";

describe("deprecate middleware", () => {
  it("sets the configured Sunset and Deprecation headers on deprecated routes", async () => {
    const app = express();
    app.get(
      "/deprecated",
      deprecate({ sunsetDate: "Wed, 01 Jan 2027 00:00:00 GMT", successor: "/api/v2/resource" }),
      (_req, res) => res.json({ ok: true }),
    );

    const res = await supertest(app).get("/deprecated");

    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBe("true");
    expect(res.headers.sunset).toBe("Wed, 01 Jan 2027 00:00:00 GMT");
    expect(res.body).toEqual({
      ok: true,
      _deprecation: {
        sunsetDate: "Wed, 01 Jan 2027 00:00:00 GMT",
        successor: "/api/v2/resource",
      },
    });
  });

  it("does not add either header to non-deprecated routes", async () => {
    const app = express();
    app.get("/current", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/current");

    expect(res.status).toBe(200);
    expect(res.headers).not.toHaveProperty("deprecation");
    expect(res.headers).not.toHaveProperty("sunset");
  });
});
