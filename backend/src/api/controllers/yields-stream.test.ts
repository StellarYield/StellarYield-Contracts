import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { sseService } from "../../services/sse.js";
import { getYieldsStream } from "./yields-stream.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const CLIENT_IP = "127.0.0.11";

function makeStream() {
  const req = Object.assign(new EventEmitter(), {
    query: { contractId: CONTRACT_ID },
    headers: {},
    ip: CLIENT_IP,
  });
  const write = vi.fn();
  const res = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    write,
    end: vi.fn(),
    headersSent: true,
  });
  return {
    req: req as unknown as Request,
    res: res as unknown as Response,
    emitClose: () => req.emit("close"),
    write,
  };
}

describe("GET yields stream", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes the initial frame before incremental yield events and unregisters on disconnect", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const next = vi.fn();

    await getYieldsStream(stream.req, stream.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(stream.write).toHaveBeenNthCalledWith(1, ":keep-alive\n\n");

    const event = {
      type: "epoch_recorded" as const,
      contractId: CONTRACT_ID,
      epoch: 7,
      yieldAmount: "125000",
      timestamp: "2026-11-23T00:00:00.000Z",
    };
    sseService.broadcastEpochRecorded(CONTRACT_ID, event);
    expect(stream.write).toHaveBeenNthCalledWith(2, `data: ${JSON.stringify(event)}\n\n`);

    stream.emitClose();
    expect(sseService.getConnectedClientsForIp(CLIENT_IP)).toBe(0);

    sseService.broadcastEpochRecorded(CONTRACT_ID, event);
    expect(stream.write).toHaveBeenCalledTimes(2);
  });
});
