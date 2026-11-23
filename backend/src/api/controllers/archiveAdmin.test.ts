import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  restoreFromArchive: vi.fn(),
  getArchiveStatus: vi.fn(),
  incrementCounter: vi.fn(),
  recordApiKeyUsage: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));
vi.mock("../../services/archivalService.js", () => ({
  restoreFromArchive: mocks.restoreFromArchive,
  getArchiveStatus: mocks.getArchiveStatus,
}));
vi.mock("../../cache/redis.js", () => ({
  incrementCounter: mocks.incrementCounter,
  recordApiKeyUsage: mocks.recordApiKeyUsage,
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));
vi.mock("../../services/securityLogger.js", () => ({
  logSecurityEvent: mocks.logSecurityEvent,
}));

import { postArchiveRestore, getArchiveStatusHandler } from "./archiveAdmin.js";
import { requireApiKey } from "../middleware/auth.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post("/archive/restore", postArchiveRestore);
  app.get("/archive/status", getArchiveStatusHandler);
  app.post("/admin/archive/restore", requireApiKey({ role: "admin" }), postArchiveRestore);
  return app;
}

const restoreRequest = {
  contractId: "C" + "A".repeat(55),
  fromDate: "2026-01-01T00:00:00Z",
  toDate: "2026-01-02T00:00:00Z",
  table: "indexed_events",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incrementCounter.mockResolvedValue(null);
  mocks.cacheGet.mockResolvedValue(null);
  mocks.cacheSet.mockResolvedValue(undefined);
  mocks.logSecurityEvent.mockResolvedValue(undefined);
});

describe("postArchiveRestore", () => {
  it("returns the archive restore result", async () => {
    mocks.restoreFromArchive.mockResolvedValue({ table: "indexed_events", restoredCount: 2 });

    const res = await supertest(makeApp()).post("/archive/restore").send(restoreRequest);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, table: "indexed_events", restoredCount: 2 });
    expect(mocks.restoreFromArchive).toHaveBeenCalledWith(restoreRequest, "unknown");
  });

  it("returns an error when archive restore fails", async () => {
    mocks.restoreFromArchive.mockRejectedValue(new Error("database failure"));

    const res = await supertest(makeApp()).post("/archive/restore").send(restoreRequest);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Archive restore failed" });
  });
});

describe("getArchiveStatusHandler", () => {
  it("returns the archive status", async () => {
    const status = { tables: [{ name: "indexed_events", liveRows: 10, archiveRows: 2 }] };
    mocks.getArchiveStatus.mockResolvedValue(status);

    const res = await supertest(makeApp()).get("/archive/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(status);
  });

  it("returns an error when archive status lookup fails", async () => {
    mocks.getArchiveStatus.mockRejectedValue(new Error("database failure"));

    const res = await supertest(makeApp()).get("/archive/status");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to get archive status" });
  });
});

describe("archive restore authorization", () => {
  it("rejects a non-admin API key", async () => {
    mocks.query.mockResolvedValue([
      {
        id: 8,
        role: "user",
        label: "read-only",
        active: true,
        expiresAt: null,
        lastUsedAt: null,
        allowedMethods: null,
        allowedCidrs: null,
        allowedContractIds: null,
      },
    ]);

    const res = await supertest(makeApp())
      .post("/admin/archive/restore")
      .set("Authorization", "Bearer non-admin-key")
      .send(restoreRequest);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden", message: "Insufficient permissions" });
    expect(mocks.restoreFromArchive).not.toHaveBeenCalled();
  });
});
