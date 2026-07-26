import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { sseManager } from "../../services/sseManager.js";
import { createApp } from "../../app.js";
import { streamVaultEvents } from "./vaults.js";
import { streamIndexerProgress } from "./admin.js";

vi.mock("../../db/index.js", () => ({
  query: vi.fn(),
  pool: {
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock("../../services/stellar.js", () => ({
  getSorobanRpc: vi.fn(),
  readTotalAssets: vi.fn(),
  readVaultState: vi.fn(),
  readPaused: vi.fn(),
}));

function createFakeRes() {
  return {
    setHeader: vi.fn(),
    write: vi.fn(),
    flushHeaders: vi.fn(),
    on: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

function createFakeReq(query: Record<string, any> = {}, headers: Record<string, string> = {}) {
  return {
    query,
    headers,
    on: vi.fn(),
  };
}

describe("SSE Infrastructure and Endpoints (#758, #759, #760, #757)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    sseManager.reset();
    app = createApp();
  });

  afterEach(() => {
    sseManager.reset();
  });

  describe("SseManager unit & connection metrics (#760, #759, #758)", () => {
    it("tracks active connection count across clients", () => {
      expect(sseManager.getSseConnectionCount()).toBe(0);

      const fakeReq1: any = createFakeReq();
      const fakeRes1: any = createFakeRes();

      sseManager.addVaultClient(fakeReq1, fakeRes1);
      expect(sseManager.getSseConnectionCount()).toBe(1);

      const fakeReq2: any = createFakeReq();
      const fakeRes2: any = createFakeRes();

      sseManager.addIndexerClient(fakeReq2, fakeRes2);
      expect(sseManager.getSseConnectionCount()).toBe(2);

      // Simulate disconnect
      const closeHandler1 = fakeReq1.on.mock.calls.find((call: any) => call[0] === "close")?.[1];
      expect(closeHandler1).toBeDefined();
      closeHandler1();

      expect(sseManager.getSseConnectionCount()).toBe(1);
    });

    it("filters vault events based on contractIds", () => {
      const validCAddress1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const validCAddress2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

      const fakeReq: any = createFakeReq();
      const fakeRes: any = createFakeRes();

      sseManager.addVaultClient(fakeReq, fakeRes, new Set([validCAddress1]));

      // Event for address 1 should be written
      sseManager.broadcastVaultEvent({
        contractId: validCAddress1,
        type: "deposit",
        payload: { assets: "100" },
      });
      expect(fakeRes.write).toHaveBeenCalledWith(
        expect.stringContaining(validCAddress1),
      );

      fakeRes.write.mockClear();

      // Event for address 2 should NOT be written
      sseManager.broadcastVaultEvent({
        contractId: validCAddress2,
        type: "deposit",
        payload: { assets: "200" },
      });
      expect(fakeRes.write).not.toHaveBeenCalled();
    });

  });

  describe("SSE reconnection with Last-Event-ID (#761)", () => {
    const validC1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("assigns a monotonically increasing id to each vault event", () => {
      const fakeReq: any = createFakeReq();
      const fakeRes: any = createFakeRes();
      sseManager.addVaultClient(fakeReq, fakeRes);

      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "1" } });
      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "2" } });

      expect(fakeRes.write).toHaveBeenNthCalledWith(1, expect.stringMatching(/^id: 1\ndata: /));
      expect(fakeRes.write).toHaveBeenNthCalledWith(2, expect.stringMatching(/^id: 2\ndata: /));
    });

    it("replays only events after Last-Event-ID on reconnect", () => {
      // Events broadcast while no client is connected still land in the replay buffer.
      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "1" } });
      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "2" } });
      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "3" } });

      const fakeReq: any = createFakeReq({}, { "last-event-id": "1" });
      const fakeRes: any = createFakeRes();
      sseManager.addVaultClient(fakeReq, fakeRes, new Set([validC1]));

      expect(fakeRes.write).toHaveBeenCalledTimes(2);
      expect(fakeRes.write).toHaveBeenNthCalledWith(1, expect.stringMatching(/^id: 2\ndata: /));
      expect(fakeRes.write).toHaveBeenNthCalledWith(2, expect.stringMatching(/^id: 3\ndata: /));
    });

    it("replays nothing for a client with no Last-Event-ID (only future events)", () => {
      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "1" } });

      const fakeReq: any = createFakeReq();
      const fakeRes: any = createFakeRes();
      sseManager.addVaultClient(fakeReq, fakeRes, new Set([validC1]));

      expect(fakeRes.write).not.toHaveBeenCalled();

      sseManager.broadcastVaultEvent({ contractId: validC1, type: "deposit", payload: { assets: "2" } });
      expect(fakeRes.write).toHaveBeenCalledWith(expect.stringMatching(/^id: 2\ndata: /));
    });
  });

  describe("SseManager indexer progress broadcast (#757)", () => {
    it("broadcasts indexer progress events to indexer clients", () => {
      const fakeReq: any = createFakeReq();
      const fakeRes: any = createFakeRes();

      sseManager.addIndexerClient(fakeReq, fakeRes);

      sseManager.broadcastIndexerProgress({
        lastLedger: 12345,
        eventsProcessed: 3,
        tickDurationMs: 42,
      });

      expect(fakeRes.write).toHaveBeenCalledWith(
        'data: {"lastLedger":12345,"eventsProcessed":3,"tickDurationMs":42}\n\n',
      );
    });
  });

  describe("GET /health response (#760)", () => {
    it("returns sseConnections count in GET /health", async () => {
      const fakeReq: any = createFakeReq();
      const fakeRes: any = createFakeRes();

      sseManager.addVaultClient(fakeReq, fakeRes);

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sseConnections", 1);
    });
  });

  describe("GET /api/v1/vaults/stream (#758)", () => {
    const validC1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const validC2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    it("rejects invalid contract IDs with 400 Bad Request before opening stream", async () => {
      const res = await request(app).get("/api/v1/vaults/stream?contractIds=invalid-id");

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Bad Request");
      expect(res.body.message).toContain("Invalid contract ID format");
    });

    it("rejects list containing at least one invalid contract ID with 400 Bad Request", async () => {
      const res = await request(app).get(`/api/v1/vaults/stream?contractIds=${validC1},invalid-id`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Bad Request");
    });

    it("accepts valid contract IDs and sets SSE headers via streamVaultEvents", () => {
      const req: any = createFakeReq({ contractIds: `${validC1},${validC2}` });
      const res: any = createFakeRes();

      streamVaultEvents(req, res);

      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
      expect(sseManager.getSseConnectionCount()).toBe(1);
    });
  });

  describe("GET /api/v1/admin/indexer/stream (#757)", () => {
    it("returns 401 Unauthorized when missing API key", async () => {
      const res = await request(app).get("/api/v1/admin/indexer/stream");

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Unauthorized");
    });

    it("streams indexer progress via streamIndexerProgress controller", () => {
      const req: any = createFakeReq();
      const res: any = createFakeRes();

      streamIndexerProgress(req, res);

      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
      expect(sseManager.getSseConnectionCount()).toBe(1);
    });
  });
});
