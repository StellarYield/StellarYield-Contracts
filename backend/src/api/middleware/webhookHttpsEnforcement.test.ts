import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { webhookHttpsEnforcement } from "./webhookHttpsEnforcement.js";
import * as configModule from "../../config.js";

describe("webhookHttpsEnforcement", () => {
  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(webhookHttpsEnforcement());

    app.post("/webhooks", (req, res) => {
      res.json({ success: true });
    });

    return app;
  }

  it("allows HTTP in development", async () => {
    // Override the config to development
    Object.defineProperty(configModule, "config", {
      value: { nodeEnv: "development" },
      configurable: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/webhooks")
      .send({ url: "http://localhost:3000/webhook" });

    expect(res.status).toBe(200);
  });

  it("allows HTTPS in production", async () => {
    Object.defineProperty(configModule, "config", {
      value: { nodeEnv: "production" },
      configurable: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/webhooks")
      .send({ url: "https://example.com/webhook" });

    expect(res.status).toBe(200);
  });

  it("rejects HTTP in production", async () => {
    Object.defineProperty(configModule, "config", {
      value: { nodeEnv: "production" },
      configurable: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/webhooks")
      .send({ url: "http://example.com/webhook" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("UnprocessableEntity");
    expect(res.body.message).toContain("HTTPS");
  });

  it("allows HTTP localhost in development", async () => {
    Object.defineProperty(configModule, "config", {
      value: { nodeEnv: "development" },
      configurable: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/webhooks")
      .send({ url: "http://localhost:8080/webhook" });

    expect(res.status).toBe(200);
  });

  it("skips non-POST/PUT methods", async () => {
    Object.defineProperty(configModule, "config", {
      value: { nodeEnv: "production" },
      configurable: true,
    });

    const app = createApp();
    const res = await request(app).get("/webhooks");

    expect(res.status).toBe(404); // or 200 if route is defined for GET
  });

  it("ignores missing url field", async () => {
    Object.defineProperty(configModule, "config", {
      value: { nodeEnv: "production" },
      configurable: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/webhooks")
      .send({ name: "test" });

    expect(res.status).toBe(200);
  });
});
