import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  query: mocks.query,
}));

import { sseService } from "../../services/sse.js";
import { getWebhookStream } from "./webhooks-stream.js";

const WEBHOOK_ID = 42;
const CLIENT_IP = "127.0.0.12";

function makeStream() {
  const req = Object.assign(new EventEmitter(), {
    params: { id: String(WEBHOOK_ID) },
    headers: {},
    ip: CLIENT_IP,
  });
  const write = vi.fn();
  const setHeader = vi.fn();
  const res = Object.assign(new EventEmitter(), {
    setHeader,
    write,
    end: vi.fn(),
    headersSent: true,
  });
  return {
    req: req as unknown as Request,
    res: res as unknown as Response,
    emitClose: () => req.emit("close"),
    setHeader,
    write,
  };
}

describe("GET webhook stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([{ id: WEBHOOK_ID }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sets SSE headers, delivers framed events, and releases the subscription on disconnect", async () => {
    const stream = makeStream();
    const next = vi.fn();

    await getWebhookStream(stream.req, stream.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(stream.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(stream.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(stream.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(stream.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
    expect(stream.write).toHaveBeenNthCalledWith(1, ":keep-alive\n\n");

    const event = {
      type: "delivery" as const,
      attempt: 2,
      statusCode: 503,
      durationMs: 120,
      success: false,
    };
    sseService.broadcastWebhookDelivery(WEBHOOK_ID, event);
    expect(stream.write).toHaveBeenNthCalledWith(2, `data: ${JSON.stringify(event)}\n\n`);

    stream.emitClose();
    expect(sseService.getConnectedClientsForIp(CLIENT_IP)).toBe(0);

    sseService.broadcastWebhookDelivery(WEBHOOK_ID, event);
    expect(stream.write).toHaveBeenCalledTimes(2);
  });
});
