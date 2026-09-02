import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  },
}));
vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: {
    isRunning: () => false,
    getLastIndexedLedger: async () => 0,
    getLastTickAt: () => null,
    getEventsIndexedCount: async () => 0,
  },
}));
vi.mock("../../services/jobQueue.js", () => ({
  jobQueue: {
    send: vi.fn(),
    getJob: vi.fn(),
    getFailedJobs: vi.fn(() => []),
  },
}));
vi.mock("../../services/sseManager.js", () => ({
  sseManager: {
    addIndexerClient: vi.fn(),
  },
}));
vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const openapiDir = resolve(__dirname, "../../openapi");

async function getTestContext() {
  const { getApiDiff } = await import("./admin.js");
  return { getApiDiff };
}

function makeReqRes(query?: any) {
  const req = { query: query || {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("API Diff Endpoint (#944)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/v1/admin/api-diff", () => {
    it("returns added paths when v2 has new routes", async () => {
      const { getApiDiff } = await getTestContext();
      
      // Modify v2 to add a new path
      const v2Path = resolve(openapiDir, "v2.json");
      const v2Spec = JSON.parse(readFileSync(v2Path, "utf8"));
      v2Spec.paths["/api/v1/test/new-endpoint"] = {
        get: {
          summary: "New test endpoint",
          responses: { "200": { description: "OK" } },
        },
      };
      writeFileSync(v2Path, JSON.stringify(v2Spec, null, 2));

      const { req, res, next } = makeReqRes({ from: "v1", to: "v2" });

      await getApiDiff(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          added: expect.arrayContaining(["/api/v1/test/new-endpoint"]),
        }),
      );

      // Restore v2
      const v1Spec = JSON.parse(readFileSync(resolve(openapiDir, "v1.json"), "utf8"));
      writeFileSync(v2Path, JSON.stringify(v1Spec, null, 2));
    });

    it("returns removed paths when v1 has routes not in v2", async () => {
      const { getApiDiff } = await getTestContext();
      
      // Modify v2 to remove a path
      const v2Path = resolve(openapiDir, "v2.json");
      const v2Spec = JSON.parse(readFileSync(v2Path, "utf8"));
      const pathToRemove = Object.keys(v2Spec.paths)[0];
      delete v2Spec.paths[pathToRemove];
      writeFileSync(v2Path, JSON.stringify(v2Spec, null, 2));

      const { req, res, next } = makeReqRes({ from: "v1", to: "v2" });

      await getApiDiff(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          removed: expect.arrayContaining([pathToRemove]),
        }),
      );

      // Restore v2
      const v1Spec = JSON.parse(readFileSync(resolve(openapiDir, "v1.json"), "utf8"));
      writeFileSync(v2Path, JSON.stringify(v1Spec, null, 2));
    });

    it("returns modified paths when schema changes", async () => {
      const { getApiDiff } = await getTestContext();
      
      // Modify v2 to change a path schema
      const v2Path = resolve(openapiDir, "v2.json");
      const v2Spec = JSON.parse(readFileSync(v2Path, "utf8"));
      const pathToModify = "/health";
      if (v2Spec.paths[pathToModify]) {
        v2Spec.paths[pathToModify].get.summary = "Modified health check";
      }
      writeFileSync(v2Path, JSON.stringify(v2Spec, null, 2));

      const { req, res, next } = makeReqRes({ from: "v1", to: "v2" });

      await getApiDiff(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          modified: expect.arrayContaining([pathToModify]),
        }),
      );

      // Restore v2
      const v1Spec = JSON.parse(readFileSync(resolve(openapiDir, "v1.json"), "utf8"));
      writeFileSync(v2Path, JSON.stringify(v1Spec, null, 2));
    });

    it("returns 400 for unknown version string", async () => {
      const { getApiDiff } = await getTestContext();
      const { req, res, next } = makeReqRes({ from: "v1", to: "v99" });

      await getApiDiff(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Invalid version. Only 'v1' and 'v2' are supported",
      });
    });

    it("returns 400 when from parameter is missing", async () => {
      const { getApiDiff } = await getTestContext();
      const { req, res, next } = makeReqRes({ to: "v2" });

      await getApiDiff(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Both 'from' and 'to' query parameters are required",
      });
    });

    it("returns 400 when to parameter is missing", async () => {
      const { getApiDiff } = await getTestContext();
      const { req, res, next } = makeReqRes({ from: "v1" });

      await getApiDiff(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "Both 'from' and 'to' query parameters are required",
      });
    });
  });
});
