import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import express from "express";
import supertest from "supertest";
import { upsertFlag } from "../../services/featureFlags.js";
import { requireFlag } from "./featureFlag.js";

describe("requireFlag", () => {
  it("passes through when the flag is enabled", async () => {
    upsertFlag("featureFlag.test.enabled", { enabled: true, rolloutPercent: 100 });
    const handler = vi.fn((_req: Request, res: Response) => res.json({ ok: true }));
    const app = express();
    app.get("/flagged", requireFlag("featureFlag.test.enabled"), handler);

    const res = await supertest(app).get("/flagged");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["featureFlag.test.disabled", "featureFlag.test.missing"])(
    "returns 404 and skips the handler when flag %s is unavailable",
    async (flagName) => {
      if (flagName.endsWith("disabled")) {
        upsertFlag(flagName, { enabled: false, rolloutPercent: 100 });
      }
      const handler = vi.fn((_req: Request, res: Response) => res.json({ ok: true }));
      const app = express();
      app.get("/flagged", requireFlag(flagName), handler);

      const res = await supertest(app).get("/flagged");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "NotFound", message: "Feature not available" });
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
