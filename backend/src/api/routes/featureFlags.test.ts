import { describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type AuthRequest = { headers: { authorization?: string | string[] } };
type AuthResponse = {
  status: (code: number) => AuthResponse;
  json: (body: unknown) => void;
};

const authMocks = vi.hoisted(() => ({
  requireApiKey: vi.fn((_options: { role?: string }) => {
    return (req: AuthRequest, res: AuthResponse, next: () => void) => {
      if (req.headers.authorization !== "Bearer test-admin-key") {
        const status = req.headers.authorization === "Bearer test-readonly-key" ? 403 : 401;
        const error = status === 403 ? "Forbidden" : "Unauthorized";
        const message = status === 403 ? "Insufficient permissions" : "Missing API key";
        res.status(status).json({ error, message });
        return;
      }
      next();
    };
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  requireApiKey: authMocks.requireApiKey,
}));

async function buildApp() {
  const { featureFlagsRouter } = await import("./featureFlags.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/feature-flags", featureFlagsRouter);
  return app;
}

function adminRequest(app: ReturnType<typeof express>) {
  return supertest(app).set("Authorization", "Bearer test-admin-key");
}

describe("feature flags routes", () => {
  it("lists flags and returns a single flag", async () => {
    vi.resetModules();
    const { upsertFlag } = await import("../../services/featureFlags.js");
    upsertFlag("route-test", { enabled: true, rolloutPercent: 60 });
    const app = await buildApp();

    const listResponse = await adminRequest(app).get("/api/v1/admin/feature-flags");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual([
      expect.objectContaining({
        name: "route-test",
        enabled: true,
        enabledForRoles: [],
        rolloutPercent: 60,
      }),
    ]);

    const flagResponse = await adminRequest(app).get("/api/v1/admin/feature-flags/route-test");
    expect(flagResponse.status).toBe(200);
    expect(flagResponse.body).toMatchObject({
      name: "route-test",
      enabled: true,
      enabledForRoles: [],
      rolloutPercent: 60,
    });
  });

  it("returns 404 and the documented error body for an unknown flag", async () => {
    vi.resetModules();
    const app = await buildApp();

    const response = await adminRequest(app).get("/api/v1/admin/feature-flags/unknown");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "NotFound",
      message: "Feature flag 'unknown' not found",
    });
  });

  it("rejects requests without admin authorization", async () => {
    vi.resetModules();
    const app = await buildApp();

    const listResponse = await supertest(app).get("/api/v1/admin/feature-flags");
    const patchResponse = await supertest(app)
      .patch("/api/v1/admin/feature-flags/route-test")
      .send({ enabled: true });
    const readonlyResponse = await supertest(app)
      .get("/api/v1/admin/feature-flags")
      .set("Authorization", "Bearer test-readonly-key");

    expect(listResponse.status).toBe(401);
    expect(patchResponse.status).toBe(401);
    expect(readonlyResponse.status).toBe(403);
    expect(authMocks.requireApiKey).toHaveBeenCalledWith({ role: "admin" });
  });
});
