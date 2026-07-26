import type { Request, Response } from "express";
import { config } from "../config.js";
import { cacheGet, cacheSet } from "../cache/redis.js";

export interface VaultSseEvent {
  contractId: string;
  type: string;
  payload: Record<string, unknown>;
}

interface BufferedVaultEvent extends VaultSseEvent {
  id: number;
}

// Last event ID is persisted with a long TTL rather than forever, since it's
// only needed to survive restarts/redeploys, not as permanent storage (#761).
const LAST_EVENT_ID_TTL_SECONDS = 60 * 60 * 24 * 30;

function lastEventIdKey(contractId: string): string {
  return `sse:vault:${contractId}:lastEventId`;
}

export interface IndexerProgressSseEvent {
  lastLedger: number;
  eventsProcessed: number;
  tickDurationMs: number;
}

interface VaultClient {
  id: string;
  res: Response;
  contractIds?: Set<string>;
  heartbeatTimer: NodeJS.Timeout;
}

interface IndexerClient {
  id: string;
  res: Response;
  heartbeatTimer: NodeJS.Timeout;
}

export class SseManager {
  private activeConnections = 0;
  private vaultClients = new Map<string, VaultClient>();
  private indexerClients = new Map<string, IndexerClient>();
  private nextClientId = 1;

  // Per-vault monotonically increasing SSE event IDs and their replay buffers (#761).
  private vaultEventCounters = new Map<string, number>();
  private vaultEventBuffers = new Map<string, BufferedVaultEvent[]>();
  private warmedContractIds = new Set<string>();

  /**
   * Get the current count of open SSE connections (#760).
   */
  getSseConnectionCount(): number {
    return this.activeConnections;
  }

  /**
   * Register a new client for vault event streams (#758, #759, #760).
   */
  addVaultClient(req: Request, res: Response, contractIds?: Set<string>): void {
    const clientId = `vault-${this.nextClientId++}`;

    // Set standard SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Increment server-side SSE connection counter (#760)
    this.activeConnections++;

    // Setup heartbeat interval (#759)
    const heartbeatTimer = setInterval(() => {
      res.write(": ping\n\n");
    }, config.sseHeartbeatMs);

    const client: VaultClient = {
      id: clientId,
      res,
      contractIds: contractIds && contractIds.size > 0 ? contractIds : undefined,
      heartbeatTimer,
    };

    this.vaultClients.set(clientId, client);

    // Replay events missed while disconnected, per the Last-Event-ID request
    // header (#761). No header means the client is new — it only gets future events.
    this.replayMissedVaultEvents(req, res, client.contractIds);

    // Clean up on disconnect (#760)
    const cleanup = () => {
      if (this.vaultClients.has(clientId)) {
        clearInterval(heartbeatTimer);
        this.vaultClients.delete(clientId);
        this.activeConnections = Math.max(0, this.activeConnections - 1);
      }
    };

    req.on?.("close", cleanup);
    res.on?.("close", cleanup);
  }

  /**
   * Replay buffered vault events with an id greater than the client's
   * Last-Event-ID header (#761). The buffer only holds the most recent
   * `SSE_REPLAY_BUFFER` events per vault, so a gap longer than that is not
   * fully recoverable.
   */
  private replayMissedVaultEvents(req: Request, res: Response, contractIds?: Set<string>): void {
    const headerValue = req.headers?.["last-event-id"];
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!raw) return;

    const sinceId = parseInt(raw, 10);
    if (!Number.isFinite(sinceId)) return;

    const relevantIds = contractIds ?? new Set(this.vaultEventBuffers.keys());
    for (const contractId of relevantIds) {
      const buffer = this.vaultEventBuffers.get(contractId);
      if (!buffer) continue;
      for (const event of buffer) {
        if (event.id > sinceId) {
          res.write(this.formatVaultEvent(event));
        }
      }
    }
  }

  private formatVaultEvent(event: BufferedVaultEvent): string {
    const dataString = JSON.stringify({
      contractId: event.contractId,
      type: event.type,
      payload: event.payload,
    });
    return `id: ${event.id}\ndata: ${dataString}\n\n`;
  }

  /**
   * Register a new client for indexer progress streams (#757, #759, #760).
   */
  addIndexerClient(req: Request, res: Response): void {
    const clientId = `indexer-${this.nextClientId++}`;

    // Set standard SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Increment server-side SSE connection counter (#760)
    this.activeConnections++;

    // Setup heartbeat interval (#759)
    const heartbeatTimer = setInterval(() => {
      res.write(": ping\n\n");
    }, config.sseHeartbeatMs);

    const client: IndexerClient = {
      id: clientId,
      res,
      heartbeatTimer,
    };

    this.indexerClients.set(clientId, client);

    // Clean up on disconnect (#760)
    const cleanup = () => {
      if (this.indexerClients.has(clientId)) {
        clearInterval(heartbeatTimer);
        this.indexerClients.delete(clientId);
        this.activeConnections = Math.max(0, this.activeConnections - 1);
      }
    };

    req.on?.("close", cleanup);
    res.on?.("close", cleanup);
  }

  /**
   * Broadcast a vault event to matching SSE subscribers, assigning it a
   * monotonically increasing per-vault `id` and buffering it for replay (#761).
   */
  broadcastVaultEvent(event: VaultSseEvent): void {
    if (!this.warmedContractIds.has(event.contractId)) {
      this.warmedContractIds.add(event.contractId);
      void this.warmVaultCounter(event.contractId);
    }

    const nextId = (this.vaultEventCounters.get(event.contractId) ?? 0) + 1;
    this.vaultEventCounters.set(event.contractId, nextId);

    const buffered: BufferedVaultEvent = { ...event, id: nextId };
    const buffer = this.vaultEventBuffers.get(event.contractId) ?? [];
    buffer.push(buffered);
    while (buffer.length > config.sseReplayBufferSize) buffer.shift();
    this.vaultEventBuffers.set(event.contractId, buffer);

    const message = this.formatVaultEvent(buffered);
    for (const client of this.vaultClients.values()) {
      if (client.contractIds && !client.contractIds.has(event.contractId)) {
        continue; // Skip if client filtered by contractIds and event contractId is not in set
      }
      client.res.write(message);
    }

    // Best-effort durability so the counter survives restarts (#761, #201).
    void cacheSet(lastEventIdKey(event.contractId), nextId, LAST_EVENT_ID_TTL_SECONDS);
  }

  /**
   * Catch the in-memory counter up to the last persisted value for a vault
   * the first time it's seen in this process. Runs in the background — any
   * events broadcast before it resolves may reuse IDs from a prior process
   * life, which is an accepted tradeoff of not blocking event delivery on Redis.
   */
  private async warmVaultCounter(contractId: string): Promise<void> {
    const persisted = await cacheGet<number>(lastEventIdKey(contractId));
    if (persisted == null) return;
    const current = this.vaultEventCounters.get(contractId) ?? 0;
    if (persisted > current) {
      this.vaultEventCounters.set(contractId, persisted);
    }
  }

  /**
   * Broadcast indexer tick progress event to subscribers (#757).
   */
  broadcastIndexerProgress(progress: IndexerProgressSseEvent): void {
    const dataString = JSON.stringify({
      lastLedger: progress.lastLedger,
      eventsProcessed: progress.eventsProcessed,
      tickDurationMs: progress.tickDurationMs,
    });
    const message = `data: ${dataString}\n\n`;

    for (const client of this.indexerClients.values()) {
      client.res.write(message);
    }
  }

  /**
   * Reset state (useful for tests).
   */
  reset(): void {
    for (const client of this.vaultClients.values()) {
      clearInterval(client.heartbeatTimer);
    }
    for (const client of this.indexerClients.values()) {
      clearInterval(client.heartbeatTimer);
    }
    this.vaultClients.clear();
    this.indexerClients.clear();
    this.activeConnections = 0;
    this.vaultEventCounters.clear();
    this.vaultEventBuffers.clear();
    this.warmedContractIds.clear();
  }
}

export const sseManager = new SseManager();
export default sseManager;
