import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getRegistry() {
  return import("./requestBodyRegistry.js");
}

describe("request body schema registry (#941)", () => {
  it("normalises routes before matching", async () => {
    const { normalizeRoute } = await getRegistry();

    expect(normalizeRoute("api/v1/webhooks")).toBe("/api/v1/webhooks");
    expect(normalizeRoute("/api/v1/webhooks/")).toBe("/api/v1/webhooks");
    expect(normalizeRoute("/api//v1/webhooks?x=1")).toBe("/api/v1/webhooks");
    expect(normalizeRoute("/")).toBe("/");
  });

  it("resolves a registered route to its schema", async () => {
    const { findBodySchema } = await getRegistry();
    const { createWebhookSchema } = await import("../routes/webhooks.js");

    expect(findBodySchema("POST", "/api/v1/webhooks")).toBe(createWebhookSchema);
  });

  it("returns null for unknown routes and methods", async () => {
    const { findBodySchema } = await getRegistry();

    expect(findBodySchema("POST", "/api/v1/nope")).toBeNull();
    expect(findBodySchema("DELETE", "/api/v1/webhooks")).toBeNull();
  });

  it("registers only routes that actually take a request body", async () => {
    const { REGISTERED_ROUTES } = await getRegistry();

    expect(REGISTERED_ROUTES.length).toBeGreaterThan(0);
    for (const entry of REGISTERED_ROUTES) {
      expect(entry.method).toBe(entry.method.toUpperCase());
      expect(entry.path.startsWith("/api/v1/")).toBe(true);
      expect(typeof entry.schema.safeParse).toBe("function");
    }
  });
});
