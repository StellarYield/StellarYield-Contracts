import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: {
    totalCount: 5,
    idleCount: 5,
    waitingCount: 0,
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

import supertest from "supertest";
import { createApp } from "../app.js";
import { getMetrics, http5xxTotal, recordHttp5xx } from "./metrics.js";
import { query } from "../db/index.js";

const VAULT_CONTRACT = "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557";

const app = createApp();

async function scrapeCounter(name: string): Promise<string> {
  return (await getMetrics())
    .split("\n")
    .filter((line) => line.startsWith(name))
    .join("\n");
}

describe("http_5xx_total (#1091)", () => {
  beforeEach(() => {
    http5xxTotal.reset();
    vi.mocked(query).mockResolvedValue([]);
  });

  it("increments the counter for a 500 response", async () => {
    recordHttp5xx("GET", "/api/v1/vaults", 500);

    const lines = await scrapeCounter("http_5xx_total");
    expect(lines).toContain('method="GET"');
    expect(lines).toContain('route="/api/v1/vaults"');
    expect(lines).toContain(" 1");
  });

  it("increments once per 5xx response, including 502 and 503", async () => {
    recordHttp5xx("POST", "/api/v1/webhooks", 500);
    recordHttp5xx("POST", "/api/v1/webhooks", 503);
    recordHttp5xx("POST", "/api/v1/webhooks", 502);

    const lines = await scrapeCounter("http_5xx_total");
    expect(lines).toMatch(/http_5xx_total\{[^}]*\} 3/);
  });

  it("reports 0 for a route that has not produced a 5xx", async () => {
    recordHttp5xx("GET", "/api/v1/yields", 200);
    recordHttp5xx("GET", "/api/v1/yields", 404);

    expect(await scrapeCounter("http_5xx_total")).toContain(
      'http_5xx_total{method="GET",route="/api/v1/yields"} 0',
    );
  });

  it("does not create a series for an unmatched path", async () => {
    // 404s are not 5xx, and a raw path would be an unbounded label value.
    recordHttp5xx("GET", "/api/v1/does-not-exist", 404, false);

    expect(await scrapeCounter("http_5xx_total")).toBe("");
  });

  it("still counts a 5xx that happened on an unmatched path", async () => {
    recordHttp5xx("GET", "/api/v1/boom", 500, false);

    expect(await scrapeCounter("http_5xx_total")).toContain('route="/api/v1/boom"');
  });

  it("falls back to 'unknown' labels and ignores a non-numeric status", async () => {
    recordHttp5xx(undefined, undefined, 500);
    recordHttp5xx("GET", "/api/v1/yields", Number.NaN);

    const lines = await scrapeCounter("http_5xx_total");
    expect(lines).toContain('method="unknown"');
    expect(lines).toContain('route="unknown"');
    // The NaN status was dropped entirely rather than opening a second series.
    expect(lines.match(/http_5xx_total\{/g)).toHaveLength(1);
  });

  it("counts a 5xx response served through the app", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));

    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}`);

    expect(res.status).toBe(500);
    const lines = await scrapeCounter("http_5xx_total");
    expect(lines).toContain('method="GET"');
    expect(lines).toContain('route="/:contractId"');
    expect(lines).toMatch(/http_5xx_total\{[^}]*\} 1/);
  });

  it("reports 0 for a healthy route served through the app", async () => {
    const res = await supertest(app).get("/health");

    expect(res.status).toBe(200);
    // The label is the full mount path, not the router-relative "/", so routes
    // served by two different routers cannot collapse into one series.
    expect(await scrapeCounter("http_5xx_total")).toContain(
      'http_5xx_total{method="GET",route="/health"} 0',
    );
  });

  it("ignores a 404 from an unmatched path", async () => {
    const res = await supertest(app).get("/api/v1/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(await scrapeCounter("http_5xx_total")).toBe("");
  });

  it("is exposed on /metrics", async () => {
    recordHttp5xx("GET", "/api/v1/metrics-probe", 500);

    const res = await supertest(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain("http_5xx_total");
  });
});
