import { tvlPubSub } from "./tvlPubSub.js";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query, withTransaction } from "../db/index.js";
import { userServiceInstance } from "./userSingleton.js";
import {
  getSorobanRpc,
  readRwaName,
  readRwaSymbol,
  readRwaDocumentUri,
} from "./stellar.js";
import { VaultService } from "./vault.js";
import { UserService } from "./user.js";
import { YieldService } from "./yield.js";
import { NotificationService } from "./notifications.js";
import {
  indexerEventsProcessedTotal,
  indexerLagSeconds,
  indexerLastLedger,
  indexerProcessingDurationSeconds,
  indexerUnknownEventsTotal,
} from "./metrics.js";
import { cacheDel } from "../cache/redis.js";
import { sseService } from "./sse.js";
import { recordRpcSuccess, recordRpcError } from "./rpcMonitor.js";
import { timedRpcCall } from "./rpcClient.js";
import { TOPIC_EVENT_TYPES } from "./indexerEventTypes.js";
import { logSystemAudit } from "./adminAuditLog.js";
import { recordLedgerAnchor, ledgerToTimestamp } from "./ledgerEstimator.js";

// ── Lightweight trace spans (#827) ────────────────────────────────────────────
// No external tracing dependency — spans are emitted as structured pino log
// entries with traceId/spanId/parentSpanId so they can be correlated in any
// log aggregator (Loki, CloudWatch, Datadog, etc.).

let _spanSeq = 0;
function nextSpanId(): string {
  return (++_spanSeq).toString(16).padStart(8, "0");
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  attrs: Record<string, unknown>;
}

function startSpan(name: string, attrs: Record<string, unknown> = {}, parent?: Span): Span {
  const traceId = parent?.traceId ?? nextSpanId() + nextSpanId();
  return { traceId, spanId: nextSpanId(), parentSpanId: parent?.spanId, name, startMs: Date.now(), attrs };
}

function finishSpan(span: Span, extra: Record<string, unknown> = {}): void {
  const durationMs = Date.now() - span.startMs;
  logger.debug(
    { traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, durationMs, ...span.attrs, ...extra },
    span.name,
  );
}

// ── Upstream helpers ───────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse a NUMERIC column (returned by pg as a string) into a bigint. Asset
// amounts are stored as integers; any fractional part is truncated and
// null/invalid values fall back to 0 so callers never throw.
function toBigIntOrZero(value: string | null | undefined): bigint {
  if (value == null) return 0n;
  const integerPart = value.split(".")[0];
  try {
    return BigInt(integerPart || "0");
  } catch {
    return 0n;
  }
}

// When an event happened on-chain: the ledger close time, or now if the RPC
// response did not include it.
function eventChangedAt(rawEvent: any): Date {
  const closedAt = typeof rawEvent?.ledgerClosedAt === "string" ? new Date(rawEvent.ledgerClosedAt) : null;
  return closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : new Date();
}

function getEventTopics(rawEvent: any): unknown[] | null {
  const topics = rawEvent?.topic ?? rawEvent?.topics;
  return Array.isArray(topics) ? topics : null;
}

function getEventData(rawEvent: any): unknown | null {
  return rawEvent?.value ?? rawEvent?.data ?? null;
}

function parseRawEventName(rawEvent: any): { topics: unknown[]; data: unknown } | null {
  const topics = getEventTopics(rawEvent);
  const data = getEventData(rawEvent);
  if (!topics || data === null) return null;
  return { topics, data };
}

// Upper bound on any single retry wait (#1204).
export const RPC_BACKOFF_MAX_DELAY_MS = 30_000;

// Full jitter (#1204): each retry waits a random time between 0 and the
// exponential ceiling, so instances rate-limited together do not retry in
// lockstep. `random` is injectable so tests can pass a seeded source.
export async function withBackoff<T>(
  fn: () => Promise<T>,
  retries = 5,
  startDelayMs = 1000,
  random: () => number = Math.random,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      const result = await fn();
      recordRpcSuccess();
      return result;
    } catch (err: any) {
      recordRpcError();
      const is429 =
        err?.response?.status === 429 ||
        err?.status === 429 ||
        String(err?.message ?? "").includes("429");
      if (!is429 || attempt >= retries) throw err;
      const delayMs = Math.min(random() * startDelayMs * Math.pow(2, attempt), RPC_BACKOFF_MAX_DELAY_MS);
      logger.warn(
        { attempt: attempt + 1, delayMs },
        "RPC 429 rate-limit; retrying with backoff",
      );
      await wait(delayMs);
      attempt++;
    }
  }
}

// ── Decode helpers (exported for testing) ─────────────────────────────────────

export function decodeSymbol(topic: any): string {
  try {
    return String(scValToNative(topic) ?? "");
  } catch {
    return "";
  }
}

export function decodeAddr(topic: any): string {
  try {
    const v = scValToNative(topic);
    return typeof v === "string" ? v : String(v ?? "");
  } catch {
    return "";
  }
}

export function decodeBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(Math.trunc(val));
  if (typeof val === "string" && /^-?\d+$/.test(val)) return BigInt(val);
  if (Array.isArray(val) && val.length > 0) return decodeBigInt(val[0]);
  if (val && typeof val === "object") {
    const first = Object.values(val as Record<string, unknown>)[0];
    if (first !== undefined) return decodeBigInt(first);
  }
  return 0n;
}

export function decodeValue(ev: any): unknown {
  try {
    return scValToNative(ev.value);
  } catch {
    return null;
  }
}

/**
 * Position of an event within its ledger (#1214): `[txIndex, eventIndex]`.
 *
 * The RPC event `id` is `<19-char TOID>-<10-char event index>`; the TOID packs
 * the ledger sequence, transaction index and operation index. The trailing
 * number is the index of the event within its transaction. Falls back to the
 * RPC's explicit `transactionIndex` when the `id` cannot be parsed, and to
 * `null` when nothing is available (e.g. older fixtures) so reads can fall back
 * to insertion order.
 */
export function eventPosition(ev: any): [number | null, number | null] {
  const fromField = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    return null;
  };

  const explicitTx = fromField(ev?.transactionIndex);
  let txIndex: number | null = null;
  let eventIndex: number | null = null;

  const id = typeof ev?.id === "string" ? ev.id : typeof ev?.pagingToken === "string" ? ev.pagingToken : "";
  const parts = id.split("-");
  const toidPart = parts[0] ?? "";
  const eventPart = parts[1] ?? "";
  if (/^\d+$/.test(toidPart)) {
    try {
      const toid = Number(BigInt(toidPart));
      if (Number.isFinite(toid)) {
        txIndex = Math.floor(toid / 4096) % 1048576;
      }
    } catch {
      txIndex = null;
    }
  }
  if (/^\d+$/.test(eventPart)) eventIndex = parseInt(eventPart, 10);
  else if (parts.length === 1 && /^\d+$/.test(id)) eventIndex = parseInt(id, 10);

  if (txIndex === null) txIndex = explicitTx;
  if (eventIndex === null) eventIndex = 0;

  return [txIndex, eventIndex];
}

export async function storeIndexedEvent(
  contractId: string,
  eventType: string,
  ev: any,
  payload: Record<string, unknown>,
  parsedData?: Record<string, unknown>,
): Promise<void> {
  const [txIndex, eventIndex] = eventPosition(ev);
  await query(
    `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload, parsed_data, tx_index, event_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ev.ledger, ev.txHash, contractId, eventType, JSON.stringify(payload), parsedData ? JSON.stringify(parsedData) : null, txIndex, eventIndex],
  );
}

// ── Per-contract indexer controls (#1106, #1107) ──────────────────────────────

/** Decodes the first topic of a raw RPC event (its symbol), or null. */
export function eventTopicName(rawEvent: unknown): string | null {
  const topics = getEventTopics(rawEvent);
  if (!topics || topics.length === 0) return null;
  try {
    const first = topics[0];
    const scVal = typeof first === "string" ? xdr.ScVal.fromXDR(first, "base64") : first;
    const name = String(scValToNative(scVal as xdr.ScVal) ?? "");
    return name || null;
  } catch {
    return null;
  }
}

/** Stored `event_type` for a raw event, falling back to its topic symbol. */
export function resolveEventType(rawEvent: unknown): string | null {
  const name = eventTopicName(rawEvent);
  if (name === null) return null;
  return TOPIC_EVENT_TYPES[name] ?? name;
}

export interface ContractIndexerControl {
  indexingPaused: boolean;
  pausedAtLedger: number | null;
  allowedEventTypes: string[];
}

/**
 * Whether an event passes a contract's event-type filter (#1106). An empty
 * list means no filter. Operators may name either the stored event type
 * (`yield_distributed`) or the on-chain topic symbol (`yield_dis`).
 */
export function isEventTypeAllowed(rawEvent: unknown, allowedTypes: string[]): boolean {
  if (allowedTypes.length === 0) return true;
  const topicName = eventTopicName(rawEvent);
  const eventType = resolveEventType(rawEvent);
  return (
    (eventType !== null && allowedTypes.includes(eventType)) ||
    (topicName !== null && allowedTypes.includes(topicName))
  );
}

// ── Indexer ────────────────────────────────────────────────────────────────────

export class Indexer {
  lastLedger: number;
  private running = false;
  private lastTickAt: Date | null = null;
  private readonly vaultFactoryContractId: string;
  private watchedContractIds: Set<string>;
  private vaultService: VaultService;
  private userService: UserService;
  private notificationService?: NotificationService;
  /** Per-contract pause / event-filter settings, refreshed every cycle. */
  private contractControls = new Map<string, ContractIndexerControl>();
  /** Topics already warned about during this process lifetime. */
  private readonly warnedUnknownTopics = new Set<string>();
  private currentBatchSize: number;
  private consecutiveFastBatches = 0;
  private readonly minBatchSize: number;
  private readonly maxBatchSize: number;

  constructor(notificationService?: NotificationService) {
    this.lastLedger = config.indexer.startLedger;
    this.vaultFactoryContractId = config.stellar.vaultFactoryContractId;
    this.watchedContractIds = new Set<string>();
    if (this.vaultFactoryContractId) {
      this.watchedContractIds.add(this.vaultFactoryContractId);
    }
    this.vaultService = new VaultService();
    this.userService = new UserService();
    this.notificationService = notificationService;
    const minBatchSize = config.indexer.minBatchSize ?? 1;
    const maxBatchSize = Math.max(minBatchSize, config.indexer.maxBatchSize ?? config.indexer.batchSize);
    this.minBatchSize = minBatchSize;
    this.maxBatchSize = maxBatchSize;
    this.currentBatchSize = Math.max(minBatchSize, Math.min(maxBatchSize, config.indexer.batchSize));

    if (!this.vaultFactoryContractId) {
      logger.warn(
        "VAULT_FACTORY_CONTRACT_ID is not configured. Event polling will be skipped. " +
        "Only indexer_state will be updated. Please set VAULT_FACTORY_CONTRACT_ID to enable event indexing.",
      );
    }
  }

  async start(): Promise<void> {
    this.running = true;

    try {
      const { startBlock } = await this.getStartLedgerConfig();
      this.lastLedger = await this.getLastIndexedLedger();
      // A configured start block (#1105) is the origin of a fresh indexing run:
      // while the cursor is still 0 no progress has been recorded, so the block
      // is not being skipped over. Once the cursor advances the start block is
      // ignored again, which is why the admin endpoint reports it as inactive.
      if (this.lastLedger === 0 && startBlock > 0) {
        this.lastLedger = startBlock;
      }
      logger.info(
        { ledger: this.lastLedger, startBlock },
        `resuming from ledger ${this.lastLedger}`,
      );

      if (!this.vaultFactoryContractId) {
        logger.info("Indexer started in state-only mode (no contract ID configured)");
        while (this.running) {
          await this.tickStateOnly();
          await this.sleepWhileRunning(config.indexer.pollIntervalMs);
        }
        return;
      }

      const server = getSorobanRpc();
      const { sequence: tipLedger } = await withBackoff(() => timedRpcCall("getLatestLedger", () => server.getLatestLedger()));
      const gap = tipLedger - this.lastLedger;

      if (gap > this.currentBatchSize) {
        await this.backfill(tipLedger);
      }

      while (this.running) {
        await this.tick();
        await this.sleepWhileRunning(config.indexer.pollIntervalMs);
      }
    } catch (err) {
      logger.error({ err }, "Indexer failed to start");
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Current adaptive ledger batch size (#1213). Exposed for the admin API. */
  getBatchSize(): number {
    return this.currentBatchSize;
  }

  /**
   * Adapt the batch size to observed throughput (#1213).
   *
   * While catching up the RPC is the bottleneck, so a fast batch (under one
   * second) signals headroom: after three in a row the batch doubles, capped at
   * `maxBatchSize`. A slow batch — or a failed/timed-out fetch, which is the
   * usual symptom of asking for too much at the chain tip — resets the fast
   * streak and halves the batch, floored at `minBatchSize`.
   */
  private tuneBatchSize(durationMs: number, failed = false): void {
    if (failed || durationMs >= 1000) {
      this.consecutiveFastBatches = 0;
      const shrunk = Math.max(this.minBatchSize, Math.floor(this.currentBatchSize / 2));
      if (shrunk !== this.currentBatchSize) {
        logger.info(
          { from: this.currentBatchSize, to: shrunk, durationMs, failed },
          "Indexer batch size reduced",
        );
      }
      this.currentBatchSize = shrunk;
      return;
    }

    this.consecutiveFastBatches += 1;
    if (this.consecutiveFastBatches >= 3 && this.currentBatchSize < this.maxBatchSize) {
      const grown = Math.min(this.maxBatchSize, this.currentBatchSize * 2);
      logger.info(
        { from: this.currentBatchSize, to: grown, durationMs },
        "Indexer batch size increased",
      );
      this.currentBatchSize = grown;
      this.consecutiveFastBatches = 0;
    }
  }

  private async tickStateOnly(): Promise<void> {
    const server = getSorobanRpc();

    let latestLedger: number;
    try {
      const resp = await withBackoff(() => timedRpcCall("getLatestLedger", () => server.getLatestLedger()));
      latestLedger = resp.sequence;
    } catch (err) {
      logger.warn({ err }, "RPC error fetching latest ledger during state-only tick");
      return;
    }

    if (latestLedger <= this.lastLedger) {
      logger.info({ latestLedger, lastLedger: this.lastLedger }, "no new ledgers");
      this.lastTickAt = new Date();
      return;
    }

    this.lastLedger = latestLedger;
    await this.saveLastIndexedLedger(latestLedger);
    await this.recordAnchorsIfNeeded(this.lastLedger, latestLedger, []);
    logger.info({ ledger: latestLedger }, "state-only tick complete");
    this.lastTickAt = new Date();
  }

  async tick(): Promise<void> {
    const tickSpan = startSpan("indexer.tick");
    const server = getSorobanRpc();

    let latestLedger: number;
    try {
      const resp = await withBackoff(() => timedRpcCall("getLatestLedger", () => server.getLatestLedger()));
      latestLedger = resp.sequence;
    } catch (err) {
      logger.warn({ err }, "RPC error fetching latest ledger during tick");
      finishSpan(tickSpan, { error: true });
      return;
    }

    // Indexer lag alert (#672) — log error when falling behind chain tip
    const lag = latestLedger - this.lastLedger;
    const threshold = config.indexer.lagAlertLedgers;
    if (lag > threshold) {
      logger.error(`Indexer lag: ${lag} ledgers behind chain tip`);
    }
    // #1217 — expose lag as a Prometheus gauge (ledgers × 5 s/ledger).
    // Resets to 0 when caught up so alert rules can fire on any nonzero value.
    indexerLagSeconds.set(Math.max(0, lag) * 5);

    if (latestLedger <= this.lastLedger) {
      finishSpan(tickSpan, { ledgerRange: 0, eventCount: 0 });
      return;
    }

    const from = this.lastLedger + 1;
    // Cap the fetched range to the adaptive batch size (#1213) so a large
    // backlog is worked through in bounded chunks whose duration feeds the
    // tuner. `batchTo` is the last ledger this tick will process.
    const batchTo = Math.min(latestLedger, this.lastLedger + this.currentBatchSize);
    tickSpan.attrs["ledgerRange"] = `${from}-${batchTo}`;

    await this.loadContractControls();
    await this.replayResumedContracts();

    const endBatchTimer = indexerProcessingDurationSeconds.startTimer();
    const contractIds = this.activeContractIds();

    let events: any[] = [];
    // Every watched contract is paused: fetching with no filter would return
    // all network events, so skip the fetch and just advance the cursor.
    if (contractIds.length > 0 || this.watchedContractIds.size === 0) {
      const filters = contractIds.map((id) => ({ contractIds: [id] }));
      try {
        const params = { startLedger: from, filters };
        const resp = await withBackoff(() => timedRpcCall("getEvents", () => server.getEvents(params), params));
        events = resp.events;
      } catch (err) {
        logger.warn({ err, from, to: batchTo }, "RPC error fetching events during tick");
        endBatchTimer();
        this.tuneBatchSize(0, true);
        finishSpan(tickSpan, { error: true });
        return;
      }
    }

    tickSpan.attrs["eventCount"] = events.length;

    logger.info(
      { from, to: batchTo, eventCount: events.length },
      "Indexer tick complete",
    );

    // Events and the cursor commit together (#1210): a failure part-way through
    // rolls the whole batch back, so the next tick re-fetches the same range.
    try {
      await withTransaction(async () => {
        for (const event of events) {
          await this.processEvent(event, tickSpan);
        }
        await this.saveLastIndexedLedger(latestLedger);
        await this.recordAnchorsIfNeeded(from, latestLedger, events);
      });
    } catch (err) {
      endBatchTimer();
      logger.error({ err, from, to: latestLedger }, "Indexer batch failed; rolled back, cursor not advanced");
      finishSpan(tickSpan, { error: true });
      return;
    }

    // Only tune on a tick that actually advanced the cursor: an idle poll that
    // found no new ledgers would otherwise inflate the fast-batch streak.
    if (batchTo > this.lastLedger) {
      this.tuneBatchSize(batchDurationMs);
    }

    await this.notificationService?.processRetries();

    this.lastLedger = latestLedger;
    indexerLastLedger.set(latestLedger);
    this.lastTickAt = new Date();
    finishSpan(tickSpan);
  }

  private async backfill(
    tipLedger: number,
    startLedger?: number,
    onProgress?: (progress: number) => Promise<void>,
  ): Promise<void> {
    const server = getSorobanRpc();
    let cursor = startLedger !== undefined ? startLedger : this.lastLedger;
    const initialLedger = cursor;
    const totalRange = Math.max(1, tipLedger - initialLedger);
    let batchCount = 0;

    await this.loadContractControls();
    const contractIds = this.activeContractIds();
    if (contractIds.length === 0 && this.watchedContractIds.size > 0) {
      logger.info("All watched contracts are paused; skipping backfill");
      return;
    }
    const filters = contractIds.map((id) => ({ contractIds: [id] }));

    while (cursor < tipLedger) {
      // Read the adaptive batch size each iteration (#1213) so growth/shrink
      // within a catch-up run takes effect on the next batch.
      const batchSize = this.currentBatchSize;
      const batchTo = Math.min(cursor + batchSize, tipLedger);
      const remaining = tipLedger - batchTo;

      logger.info(
        { from: cursor + 1, to: batchTo, remaining },
        `Backfilling ledgers ${cursor + 1}–${batchTo} (${remaining} remaining)`,
      );

      const endBatchTimer = indexerProcessingDurationSeconds.startTimer();
      try {
        const params = { startLedger: cursor + 1, filters };
        const resp = await withBackoff(() => timedRpcCall("getEvents", () => server.getEvents(params), params));

        // Each backfill batch commits its events and cursor atomically (#1210).
        await withTransaction(async () => {
          for (const event of resp.events) {
            logger.debug(
              { contractId: event.contractId, type: event.type, ledger: event.ledger },
              "Backfill event",
            );
            await this.processEvent(event);
          }
          await this.saveLastIndexedLedger(batchTo);
          await this.recordAnchorsIfNeeded(cursor + 1, batchTo, resp.events);
        });
        endBatchTimer();

        cursor = batchTo;
        this.lastLedger = cursor;
        indexerLastLedger.set(cursor);
        this.lastTickAt = new Date();

        batchCount++;
        if (onProgress && (batchCount % 10 === 0 || cursor >= tipLedger)) {
          const pct = Math.min(100, Math.floor(((cursor - initialLedger) / totalRange) * 100));
          await onProgress(pct);
        }
      } catch (err) {
        endBatchTimer();
        this.tuneBatchSize(0, true);
        logger.warn({ err, from: cursor + 1, to: batchTo }, "RPC error during backfill batch");
        break;
      }
    }
  }

  async processEvent(event: any, parentSpan?: Span): Promise<void> {
    const eventSpan = startSpan(
      "indexer.process_event",
      { eventType: event.type ?? "unknown", contractId: event.contractId ?? "" },
      parentSpan,
    );

    try {
      const control = this.contractControls.get(event.contractId ?? "");
      if (control?.indexingPaused) {
        eventSpan.attrs["skipped"] = "contract_paused";
        return;
      }
      if (control && !isEventTypeAllowed(event, control.allowedEventTypes)) {
        eventSpan.attrs["skipped"] = "event_type_filtered";
        return;
      }

      // Count once per event actually indexed (#1109): duplicates, filtered
      // events and unrecognised events are not counted.
      if (await this._processEventInner(event)) {
        indexerEventsProcessedTotal.inc();
      }
    } catch (err) {
      // #1211: a malformed event must not abort the batch. Set it aside for
      // inspection and let the caller continue with the remaining events.
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        await this.storeDeadLetter(event, errorMessage);
      } catch (deadLetterErr) {
        logger.error(
          { err: deadLetterErr, contractId: event?.contractId ?? "", ledger: event?.ledger ?? 0 },
          "Failed to store indexer dead letter",
        );
      }
      eventSpan.attrs["error"] = true;
    } finally {
      finishSpan(eventSpan);
    }
  }

  /**
   * Refresh per-contract pause / filter settings from the database. Settings
   * are written by the admin API, which may run in a different process. On a
   * read failure the previous settings are kept.
   */
  async loadContractControls(): Promise<void> {
    try {
      const rows = await query<{
        contract_id: string;
        indexing_paused: boolean;
        paused_at_ledger: number | null;
        allowed_event_types: string[] | null;
      }>(
        `SELECT contract_id, indexing_paused, paused_at_ledger, allowed_event_types
         FROM indexer_contract_state`,
      );
      const controls = new Map<string, ContractIndexerControl>();
      for (const row of rows ?? []) {
        controls.set(row.contract_id, {
          indexingPaused: row.indexing_paused,
          pausedAtLedger: row.paused_at_ledger ?? null,
          allowedEventTypes: row.allowed_event_types ?? [],
        });
      }
      this.contractControls = controls;
    } catch (err) {
      logger.warn({ err }, "Failed to load indexer contract controls; keeping previous settings");
    }
  }

  /** Watched contracts that are not paused (#1107). */
  private activeContractIds(): string[] {
    return Array.from(this.watchedContractIds).filter(
      (id) => !this.contractControls.get(id)?.indexingPaused,
    );
  }

  /**
   * Catch up contracts resumed since the last cycle (#1107). While paused, the
   * global cursor kept moving without them, so replay each one's events from
   * the ledger it was paused at up to the current cursor, then clear the
   * marker. On an RPC failure the marker is kept and the replay retried next
   * cycle; already-indexed events are de-duplicated by processEvent.
   */
  private async replayResumedContracts(): Promise<void> {
    for (const [contractId, control] of this.contractControls) {
      if (control.indexingPaused || control.pausedAtLedger === null) continue;

      try {
        if (control.pausedAtLedger < this.lastLedger) {
          await this.replayContract(contractId, control.pausedAtLedger + 1, this.lastLedger);
        }
        await query(
          `UPDATE indexer_contract_state
           SET paused_at_ledger = NULL, updated_at = NOW()
           WHERE contract_id = $1 AND indexing_paused = FALSE`,
          [contractId],
        );
        control.pausedAtLedger = null;
        logger.info({ contractId }, "Resumed contract caught up");
      } catch (err) {
        logger.warn({ err, contractId }, "Failed to catch up resumed contract; will retry");
      }
    }
  }

  private async replayContract(contractId: string, fromLedger: number, toLedger: number): Promise<void> {
    const server = getSorobanRpc();
    const filters = [{ contractIds: [contractId] }];
    let cursor = fromLedger - 1;

    while (cursor < toLedger) {
      const batchTo = Math.min(cursor + config.indexer.batchSize, toLedger);
      const endBatchTimer = indexerProcessingDurationSeconds.startTimer();
      try {
        const params = { startLedger: cursor + 1, filters };
        const resp = await withBackoff(() => timedRpcCall("getEvents", () => server.getEvents(params), params));
        for (const event of resp.events) {
          // Events past the global cursor are picked up by the regular tick.
          if ((event.ledger ?? 0) > toLedger) continue;
          await this.processEvent(event);
        }
      } finally {
        endBatchTimer();
      }
      cursor = batchTo;
    }
  }

  private async _processEventInner(event: any): Promise<boolean> {
    const existing = await query(
      "SELECT id FROM indexed_events WHERE tx_hash = $1 AND contract_id = $2 AND event_type = $3 AND ledger = $4",
      [event.id ?? event.txHash ?? "", event.contractId ?? "", event.type ?? "", event.ledger ?? 0],
    );
    if (existing.length > 0) return false;

    const deposit = parseDepositEvent(event);
    if (deposit) {
      await this.handleDeposit(event.contractId ?? "", deposit);
      await this.recordEvent(event, "deposit");
      try {
        const posRows = await query<{ shares: string }>(
          "SELECT shares FROM user_vault_positions uvp JOIN vaults v ON v.id = uvp.vault_id WHERE v.contract_id = $1 AND uvp.user_address = $2",
          [event.contractId ?? "", deposit.receiver],
        );
        const newShares = posRows[0]?.shares ?? "0";
        await this.notificationService?.notify("user.deposit", {
          contractId: event.contractId ?? "",
          caller: deposit.caller,
          receiver: deposit.receiver,
          assets: deposit.assets.toString(),
          shares: deposit.shares.toString(),
          newShares,
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for deposit");
      }
      return true;
    }

    const withdraw = parseWithdrawEvent(event);
    if (withdraw) {
      await this.handleWithdraw(event.contractId ?? "", withdraw);
      await this.recordEvent(event, "withdraw");
      try {
        const posRows = await query<{ shares: string }>(
          "SELECT shares FROM user_vault_positions uvp JOIN vaults v ON v.id = uvp.vault_id WHERE v.contract_id = $1 AND uvp.user_address = $2",
          [event.contractId ?? "", withdraw.owner],
        );
        const remainingShares = posRows[0]?.shares ?? "0";
        await this.notificationService?.notify("user.withdraw", {
          contractId: event.contractId ?? "",
          caller: withdraw.caller,
          receiver: withdraw.receiver,
          owner: withdraw.owner,
          assets: withdraw.assets.toString(),
          shares: withdraw.shares.toString(),
          remainingShares,
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for withdraw");
      }
      return true;
    }

    const yieldDist = parseYieldDistributedEvent(event);
    if (yieldDist) {
      const feeResult = await this.handleYieldDistributed(event.contractId ?? "", yieldDist);
      // Store payload with netYield so GET /epochs can read it via lateral join (#792)
      await query(
        `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload, tx_index, event_index)
         VALUES ($1, $2, $3, 'yield_distributed', $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          event.ledger ?? 0,
          event.id ?? event.txHash ?? "",
          event.contractId ?? "",
          JSON.stringify({
            epoch: yieldDist.epoch,
            amount: yieldDist.amount.toString(),
            netYield: feeResult.netYield,
            operatorFee: feeResult.operatorFee,
          }),
          ...eventPosition(event),
        ],
      );
      const parsedData = await this.handleYieldDistributed(event.contractId ?? "", yieldDist);
      await this.recordEvent(event, "yield_distributed", parsedData);
      try {
        await this.notificationService?.notify("yield_distributed", yieldDist as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for yield_distributed");
      }
      return true;
    }

    const epochFinalized = parseEpochFinalizedEvent(event);
    if (epochFinalized) {
      await this.recordEvent(event, "epoch_finalized", {
        epochId: epochFinalized.epochId,
        totalYield: epochFinalized.totalYield.toString(),
        timestamp: epochFinalized.timestamp.toString(),
      });
      try {
        await this.notificationService?.notify("epoch.finalized", {
          contractId: event.contractId ?? "",
          epochId: epochFinalized.epochId,
          totalYield: epochFinalized.totalYield.toString(),
          timestamp:
            (typeof event.ledgerClosedAt === "string" && event.ledgerClosedAt) ||
            new Date(Number(epochFinalized.timestamp) * 1000).toISOString(),
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for epoch.finalized");
      }
      return true;
    }

    const cancelFunding = parseCancelFundingEvent(event);
    if (cancelFunding) {
      await this.handleCancelFunding(event.contractId ?? "");
      await this.recordEvent(event, "cancel_funding");
      try {
        await this.notificationService?.notify("cancel_funding", cancelFunding as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for cancel_funding");
      }
      try {
        const cancelledAt =
          (typeof event.ledgerClosedAt === "string" && event.ledgerClosedAt) ||
          new Date().toISOString();
        await this.notificationService?.notify("vault.cancelled", {
          contractId: event.contractId ?? "",
          cancelledAt,
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault.cancelled");
      }
      return true;
    }

    const vaultStateChanged = parseVaultStateChangedEvent(event);
    if (vaultStateChanged) {
      await this.handleVaultStateChanged(event.contractId ?? "", vaultStateChanged);
      await this.recordEvent(event, "vault_state_changed");
      try {
        await this.notificationService?.notify("vault_state_changed", vaultStateChanged as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault_state_changed");
      }

      // Notify subscribers when a vault reaches maturity so they can prompt
      // users to redeem (#590).
      if (vaultStateChanged.newState === "Matured") {
        const maturedAt =
          (typeof event.ledgerClosedAt === "string" && event.ledgerClosedAt) ||
          new Date().toISOString();
        try {
          await this.notificationService?.notify("vault.matured", {
            contractId: event.contractId ?? "",
            maturedAt,
          });
        } catch (e) {
          logger.warn({ err: e }, "NotificationService.notify failed for vault.matured");
        }
      }
      return true;
    }

    const vaultCreated = parseVaultCreatedEvent(event);
    if (vaultCreated) {
      await this.handleVaultCreated(event.contractId ?? "", vaultCreated, event);
      await this.recordEvent(event, "vault_created");
      try {
        await this.notificationService?.notify("vault_created", vaultCreated as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault_created");
      }
      return true;
    }

    const vaultRemoved = parseVaultRemovedEvent(event);
    if (vaultRemoved) {
      await this.handleVaultRemoved(event.contractId ?? "");
      await this.recordEvent(event, "vault_removed");
      return true;
    }

    const opAdded = parseOperatorAddedEvent(event);
    if (opAdded) {
      await this.handleOperatorAdded(event.contractId ?? "", opAdded);
      await this.recordEvent(event, "operator_added");
      return true;
    }

    const opRemoved = parseOperatorRemovedEvent(event);
    if (opRemoved) {
      await this.handleOperatorRemoved(event.contractId ?? "", opRemoved);
      await this.recordEvent(event, "operator_removed");
      return true;
    }

    const roleGranted = parseRoleGrantedEvent(event);
    if (roleGranted) {
      await this.handleRoleGranted(event.contractId ?? "", roleGranted);
      await this.recordEvent(event, "role_granted");
      return true;
    }

    const roleRevoked = parseRoleRevokedEvent(event);
    if (roleRevoked) {
      await this.handleRoleRevoked(event.contractId ?? "", roleRevoked);
      await this.recordEvent(event, "role_revoked");
      return true;
    }

    const redemptionRequest = parseRequestEarlyRedemptionEvent(event);
    if (redemptionRequest) {
      await this.handleRequestEarlyRedemption(event.contractId ?? "", redemptionRequest);
      await this.recordEvent(event, "request_early_redemption");
      try {
        const requestTime = new Date(Number(redemptionRequest.timestamp) * 1000);
        const queueRows = await query<{ pos: string }>(
          `SELECT COUNT(*)::text as pos FROM redemption_requests rr
           JOIN vaults v ON v.id = rr.vault_id
           WHERE v.contract_id = $1 AND rr.processed = FALSE
           AND rr.request_time <= $2`,
          [event.contractId ?? "", requestTime],
        );
        await this.notificationService?.notify("user.early_redemption_requested", {
          contractId: event.contractId ?? "",
          user: redemptionRequest.userAddress,
          requestId: redemptionRequest.requestId,
          shares: redemptionRequest.shares.toString(),
          queuePosition: Number(queueRows[0]?.pos ?? "0"),
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for user.early_redemption_requested");
      }
      return true;
    }

    const yieldClaimed = parseYieldClaimedEvent(event);
    if (yieldClaimed) {
      await this.handleYieldClaimed(event.contractId ?? "", yieldClaimed.user, yieldClaimed.epoch, yieldClaimed.amount);
      await query(
        `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload)
         VALUES ($1, $2, $3, 'yield_claimed', $4)
         ON CONFLICT DO NOTHING`,
        [
          event.ledger ?? 0,
          event.id ?? event.txHash ?? "",
          event.contractId ?? "",
          JSON.stringify({
            user: yieldClaimed.user,
            amount: yieldClaimed.amount.toString(),
            epoch: yieldClaimed.epoch,
          }),
        ],
      );
      return true;
    }

    const yieldClaimedPartial = parseYieldClaimedPartialEvent(event);
    if (yieldClaimedPartial) {
      await this.handleYieldClaimed(event.contractId ?? "", yieldClaimedPartial.user, yieldClaimedPartial.epoch, yieldClaimedPartial.claimed);
      await query(
        `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload)
         VALUES ($1, $2, $3, 'yield_claimed_partial', $4)
         ON CONFLICT DO NOTHING`,
        [
          event.ledger ?? 0,
          event.id ?? event.txHash ?? "",
          event.contractId ?? "",
          JSON.stringify({
            user: yieldClaimedPartial.user,
            amount: yieldClaimedPartial.claimed.toString(),
            shortfall: yieldClaimedPartial.shortfall.toString(),
            epoch: yieldClaimedPartial.epoch,
          }),
        ],
      );
      return true;
    }

    const earlyProcessed = parseEarlyRedemptionProcessedEvent(event);
    if (earlyProcessed) {
      await this.handleEarlyRedemptionProcessed(event.contractId ?? "", earlyProcessed);
      await this.recordEvent(event, "early_redemption_processed");
      return true;
    }

    const earlyCancelled = parseEarlyRedemptionCancelledEvent(event);
    if (earlyCancelled) {
      await this.handleEarlyRedemptionCancelled(event.contractId ?? "", earlyCancelled);
      await this.recordEvent(event, "early_redemption_cancelled");
      return true;
    }

    const feeUpdated = parseOperatorFeeUpdatedEvent(event);
    if (feeUpdated) {
      await this.handleOperatorFeeUpdated(event.contractId ?? "", feeUpdated);
      await this.recordEvent(event, "operator_fee_updated");
      return true;
    }

    const pauseReasonSet = parsePauseReasonSetEvent(event);
    if (pauseReasonSet) {
      await this.handlePauseReasonSet(event.contractId ?? "", pauseReasonSet);
      await this.recordEvent(event, "pause_reason_set");
      return true;
    }

    const redemptionQueueUpdated = parseRedemptionQueueUpdatedEvent(event);
    if (redemptionQueueUpdated) {
      await this.handleRedemptionQueueUpdated(event.contractId ?? "", redemptionQueueUpdated);
      await this.recordEvent(event, "redemption_queue_updated");
      return true;
    }

    const minimumDepositUpdated = parseMinimumDepositUpdatedEvent(event);
    if (minimumDepositUpdated) {
      await this.handleMinimumDepositUpdated(event.contractId ?? "", minimumDepositUpdated);
      await this.recordEvent(event, "minimum_deposit_updated");
      return true;
    }

    const zkmeUpd = parseZkmeVerifierUpdatedEvent(event);
    if (zkmeUpd) {
      await this.handleZkmeVerifierUpdated(event.contractId ?? "", zkmeUpd);
      await this.recordEvent(event, "zkme_upd");
      return true;
    }

    const adminTransferred = parseAdminTransferredEvent(event);
    if (adminTransferred) {
      await this.handleAdminTransferred(event.ledger ?? 0, adminTransferred);
      await this.recordEvent(event, "adm_xfr", {
        oldAdmin: adminTransferred.oldAdmin,
        newAdmin: adminTransferred.newAdmin,
      });
      return true;
    }

    const defaultsUpdated = parseDefaultsUpdatedEvent(event);
    if (defaultsUpdated) {
      await this.recordEvent(event, "def_upd", {
        asset: defaultsUpdated.asset,
        zkmeVerifier: defaultsUpdated.zkmeVerifier,
        cooperator: defaultsUpdated.cooperator,
      });
      return true;
    }

    const wasmHashUpdated = parseWasmHashUpdatedEvent(event);
    if (wasmHashUpdated) {
      await this.handleWasmHashUpdated(event.ledger ?? 0, wasmHashUpdated);
      await this.recordEvent(event, "wasm_upd", {
        oldHash: wasmHashUpdated.oldHash,
        newHash: wasmHashUpdated.newHash,
        updatedBy: wasmHashUpdated.updatedBy,
      });
      return true;
    }

    const kycSet = parseKycSetEvent(event);
    if (kycSet) {
      await this.handleKycSet(event.contractId ?? "", kycSet);
      await query(
        `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload)
         VALUES ($1, $2, $3, 'kyc_set', $4)
         ON CONFLICT DO NOTHING`,
        [
          event.ledger ?? 0,
          event.id ?? event.txHash ?? "",
          event.contractId ?? "",
          JSON.stringify({ user: kycSet.user, verified: kycSet.verified, timestamp: Number(kycSet.timestamp) }),
        ],
      );
      return true;
    }

    const paused = parsePausedEvent(event);
    if (paused) {
      await this.handlePauseState(event.contractId ?? "", true);
      await this.recordEvent(event, "paused");
      return true;
    }

    const unpaused = parseUnpausedEvent(event);
    if (unpaused) {
      await this.handlePauseState(event.contractId ?? "", false);
      await this.recordEvent(event, "unpaused");
      return true;
    }

    const kycUpdate = parseKycVerifiedEvent(event);
    if (kycUpdate) {
      await this.userService.upsertUser(kycUpdate.user, kycUpdate.verified);
      await this.recordEvent(event, "kyc_set");
      logger.info(
        { user: kycUpdate.user, verified: kycUpdate.verified },
        "Processed kyc_set event",
      );
      return true;
    }

    const metadataUpdated = parseMetadataUpdatedEvent(event);
    if (metadataUpdated) {
      await this.handleMetadataUpdated(event.contractId ?? "", metadataUpdated);
      await this.recordEvent(event, "rwa_details_updated", metadataUpdated as any);
      try {
        const metadataFields: { field: string; newValue: string }[] = [
          { field: "name", newValue: metadataUpdated.name },
          { field: "symbol", newValue: metadataUpdated.symbol },
          { field: "document_uri", newValue: metadataUpdated.documentUri },
          { field: "category", newValue: metadataUpdated.category },
          { field: "expected_apy", newValue: String(metadataUpdated.expectedApy) },
        ];
        for (const { field, newValue } of metadataFields) {
          await this.notificationService?.notify("vault.metadata_updated", {
            contractId: event.contractId ?? "",
            field,
            newValue,
            changedBy: null,
          });
        }
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault.metadata_updated");
      }
      return true;
    }

    // ── Issue #968: vault_name_updated ────────────────────────────────────────
    const vaultNameUpdated = parseVaultNameUpdatedEvent(event);
    if (vaultNameUpdated) {
      await this.handleVaultNameUpdated(event.contractId ?? "", vaultNameUpdated);
      await this.recordEvent(event, "vault_name_updated", {
        caller: vaultNameUpdated.caller,
        oldName: vaultNameUpdated.oldName,
        newName: vaultNameUpdated.newName,
      });
      return true;
    }

    // ── #1094: whitelist_updated ──────────────────────────────────────────────
    const whitelistUpdated = parseWhitelistUpdatedEvent(event);
    if (whitelistUpdated) {
      // The transaction hash is what an auditor follows, so it is preferred over
      // the event id that the rest of the indexer falls back to.
      await this.handleWhitelistUpdated(
        event.contractId ?? "",
        whitelistUpdated,
        event.txHash ?? event.id ?? "",
        event.ledger ?? 0,
      );
      await this.recordEvent(event, "whitelist_updated", {
        address: whitelistUpdated.address,
        action: whitelistUpdated.action,
        caller: whitelistUpdated.caller,
      });
      return true;
    }

    // ── #1065: vault_status_changed ───────────────────────────────────────────
    const vaultStatusChanged = parseVaultStatusChangedEvent(event);
    if (vaultStatusChanged) {
      const previousStatus = await this.handleVaultStatusChanged(vaultStatusChanged, event);
      await this.recordEvent(event, "vault_status_changed", {
        vault: vaultStatusChanged.vault,
        previousStatus,
        newStatus: vaultStatusChanged.status,
      });
      return true;
    }

    // ── #1068: vault_manager_changed ──────────────────────────────────────────
    const managerChanged = parseVaultManagerChangedEvent(event);
    if (managerChanged) {
      const previousManager = await this.handleVaultManagerChanged(managerChanged, event);
      await this.recordEvent(event, "vault_manager_changed", {
        vault: managerChanged.vault,
        previousManager,
        newManager: managerChanged.newManager,
      });
      try {
        await this.notificationService?.notify("vault.manager_changed", {
          contractId: managerChanged.vault,
          previousManager,
          newManager: managerChanged.newManager,
          txHash: event.txHash ?? event.id ?? "",
          ledger: event.ledger ?? 0,
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault.manager_changed");
      }
      return true;
    }

    // ── #1077 / #1113: transfer ───────────────────────────────────────────────
    const transfer = parseTransferEvent(event);
    if (transfer) {
      await this.handleTransfer(event.contractId ?? "", transfer, event);
      await this.recordEvent(event, "transfer", {
        from: transfer.from,
        to: transfer.to,
        amount: transfer.amount.toString(),
      });
      return true;
    }

    // ── #1076: transfer_fee_collected ────────────────────────────────────────
    const transferFee = parseTransferFeeCollectedEvent(event);
    if (transferFee) {
      await this.handleTransferFeeCollected(event.contractId ?? transferFee.contractId ?? "", transferFee, event);
      await this.recordEvent(event, "transfer_fee_collected", {
        from: transferFee.from,
        to: transferFee.to,
        feeAmount: transferFee.feeAmount.toString(),
      });
      return true;
    }

    const topic = eventTopicName(event);
    if (topic === null || Object.hasOwn(TOPIC_EVENT_TYPES, topic)) {
      const errorMessage = topic === null
        ? "Unable to decode event topic"
        : `Unable to parse recognized event topic: ${topic}`;
      await this.storeDeadLetter(event, errorMessage);
    } else {
      const contractId = event?.contractId ?? "";
      indexerUnknownEventsTotal.inc({ contract_id: contractId, topic });
      if (!this.warnedUnknownTopics.has(topic)) {
        this.warnedUnknownTopics.add(topic);
        logger.warn({ contractId, topic }, "Unknown indexer event topic");
      }
    }

    return false;
  }

  private async storeDeadLetter(event: any, errorMessage: string): Promise<void> {
    const rawEvent = JSON.stringify(event, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    await query(
      `INSERT INTO indexer_dead_letters (contract_id, ledger, raw_event, error_message)
       VALUES ($1, $2, $3, $4)`,
      [event?.contractId ?? "", event?.ledger ?? 0, rawEvent, errorMessage],
    );
    logger.warn(
      { contractId: event?.contractId ?? "", ledger: event?.ledger ?? 0, errorMessage },
      "Indexer event moved to dead-letter table",
    );
  }

  private async handleMetadataUpdated(
    contractId: string,
    meta: {
      name: string;
      symbol: string;
      documentUri: string;
      category: string;
      expectedApy: number;
    },
  ): Promise<void> {
    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      logger.warn({ contractId }, "rwa_details_updated for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRows[0].id;

    const prev = await query<{
      rwa_name: string | null;
      rwa_symbol: string | null;
      rwa_document_uri: string | null;
      rwa_category: string | null;
      expected_apy: number | null;
    }>(
      "SELECT rwa_name, rwa_symbol, rwa_document_uri, rwa_category, expected_apy FROM vaults WHERE id = $1",
      [vaultId],
    );
    const oldVals = prev[0] ?? {};

    await query(
      `UPDATE vaults
       SET rwa_name = $1, rwa_symbol = $2, rwa_document_uri = $3,
           rwa_category = $4, expected_apy = $5, updated_at = NOW()
       WHERE id = $6`,
      [meta.name, meta.symbol, meta.documentUri, meta.category, meta.expectedApy, vaultId],
    );

    const changes: { field: string; oldValue: string | null; newValue: string }[] = [
      { field: "name", oldValue: oldVals.rwa_name ?? null, newValue: meta.name },
      { field: "symbol", oldValue: oldVals.rwa_symbol ?? null, newValue: meta.symbol },
      { field: "document_uri", oldValue: oldVals.rwa_document_uri ?? null, newValue: meta.documentUri },
      { field: "category", oldValue: oldVals.rwa_category ?? null, newValue: meta.category },
      {
        field: "expected_apy",
        oldValue: oldVals.expected_apy != null ? String(oldVals.expected_apy) : null,
        newValue: String(meta.expectedApy),
      },
    ];
    for (const c of changes) {
      if (c.oldValue === c.newValue) continue;
      await query(
        `INSERT INTO vault_metadata_history (vault_id, field, old_value, new_value, changed_by, recorded_at)
         VALUES ($1, $2, $3, $4, NULL, NOW())`,
        [vaultId, c.field, c.oldValue, c.newValue],
      );
    }

    logger.info({ contractId }, "Processed rwa_details_updated event");
  }

  // ── Issue #968: handle vault_name_updated ─────────────────────────────────
  private async handleVaultNameUpdated(
    contractId: string,
    event: ParsedVaultNameUpdatedEvent,
  ): Promise<void> {
    const vaultRows = await query<{ id: number; name: string }>(
      "SELECT id, name FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) {
      logger.warn({ contractId }, "vault_name_updated for unknown vault — skipping");
      return;
    }
    const { id: vaultId, name: currentName } = vaultRows[0];

    // Update the canonical vault name
    await query(
      "UPDATE vaults SET name = $1, updated_at = NOW() WHERE id = $2",
      [event.newName, vaultId],
    );

    // Record the change in vault_metadata_history
    await query(
      `INSERT INTO vault_metadata_history (vault_id, field, old_value, new_value, changed_by, recorded_at)
       VALUES ($1, 'name', $2, $3, $4, NOW())`,
      [vaultId, event.oldName || currentName, event.newName, event.caller],
    );

    logger.info(
      { contractId, caller: event.caller, oldName: event.oldName, newName: event.newName },
      "Processed vault_name_updated event",
    );
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastTickAt(): Date | null {
    return this.lastTickAt;
  }

  async getEventsIndexedCount(): Promise<number> {
    const rows = await query<{ count: string }>("SELECT COUNT(*)::text as count FROM indexed_events");
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  private async handleDeposit(
    contractId: string,
    deposit: { caller: string; receiver: string; assets: bigint; shares: bigint },
  ): Promise<void> {
    await query(
      `INSERT INTO user_vault_positions (user_address, vault_id, shares, deposited, updated_at, first_entry_at)
       SELECT $1, v.id, $2, $3, NOW(), NOW()
       FROM vaults v WHERE v.contract_id = $4
       ON CONFLICT (user_address, vault_id)
       DO UPDATE SET
         shares    = user_vault_positions.shares    + EXCLUDED.shares,
         deposited = user_vault_positions.deposited + EXCLUDED.deposited,
         first_entry_at = COALESCE(user_vault_positions.first_entry_at, NOW()),
         last_exit_at = NULL,
         updated_at = NOW()`,
      [deposit.receiver, deposit.shares.toString(), deposit.assets.toString(), contractId],
    );

    // Read the funding target and the total assets prior to this deposit so we
    // can detect when the deposit pushes the vault across its funding goal (#659).
    const vaultRows = await query<{ total_assets: string | null; funding_target: string | null }>(
      "SELECT total_assets, funding_target FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    const prevTotalAssets = toBigIntOrZero(vaultRows[0]?.total_assets);
    const fundingTarget =
      vaultRows[0]?.funding_target != null ? toBigIntOrZero(vaultRows[0].funding_target) : null;
    const newTotalAssets = prevTotalAssets + deposit.assets;

    await query(
      `UPDATE vaults
       SET total_assets = $1,
           total_shares_ever_minted = total_shares_ever_minted + $2
       WHERE contract_id = $3`,
      [newTotalAssets.toString(), deposit.shares.toString(), contractId],
    );
    await this.recordTvlSnapshot(contractId);
    logger.info(
      { contractId, receiver: deposit.receiver, shares: deposit.shares.toString() },
      "Processed deposit event",
    );

    // Fire vault.funded once, only on the deposit that crosses the threshold:
    // previously below the target and now at or above it. Subsequent deposits
    // that keep the vault above target leave prevTotalAssets >= target, so the
    // event does not fire again (#659).
    if (
      fundingTarget != null &&
      fundingTarget > 0n &&
      prevTotalAssets < fundingTarget &&
      newTotalAssets >= fundingTarget
    ) {
      try {
        await this.notificationService?.notify("vault.funded", {
          contractId,
          totalAssets: newTotalAssets.toString(),
          fundingTarget: fundingTarget.toString(),
        });
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault.funded");
      }
    }
  }

  private async handleWithdraw(
    contractId: string,
    withdraw: { owner: string; assets: bigint; shares: bigint },
  ): Promise<void> {
    await query(
      `INSERT INTO user_vault_positions (user_address, vault_id, shares, deposited, last_exit_at)
       SELECT $1, v.id, 0, 0, NOW()
       FROM vaults v WHERE v.contract_id = $4
       ON CONFLICT (user_address, vault_id) DO UPDATE SET
         shares    = GREATEST(0, user_vault_positions.shares    - $2),
         deposited = GREATEST(0, user_vault_positions.deposited - $3),
         last_exit_at = CASE WHEN GREATEST(0, user_vault_positions.shares - $2) = 0 THEN NOW() ELSE NULL END,
         updated_at = NOW()`,
      [withdraw.owner, withdraw.shares.toString(), withdraw.assets.toString(), contractId],
    );
    await query(
      `UPDATE vaults SET total_shares_ever_burned = total_shares_ever_burned + $1 WHERE contract_id = $2`,
      [withdraw.shares.toString(), contractId],
    );
    await this.recordTvlSnapshot(contractId);
    logger.info(
      { contractId, owner: withdraw.owner, shares: withdraw.shares.toString() },
      "Processed withdraw event",
    );
    
    // Get updated position and emit SSE event
    const positionResult = await query<{ shares: string; deposited: string }>(
      `SELECT shares, deposited FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND v.contract_id = $2`,
      [withdraw.owner, contractId],
    );
    if (positionResult.length > 0) {
      const { shares, deposited } = positionResult[0];
      userServiceInstance.emitPositionUpdate(withdraw.owner, contractId, shares, deposited);
    }

    // #1274 – re-derive settlement_status after every withdrawal so dashboards
    // can see the transition from not_started → in_progress → complete.
    await this.refreshSettlementStatus(contractId);
  }

  private async handleYieldDistributed(
    contractId: string,
    yieldDist: { epoch: number; amount: bigint; timestamp: bigint },
  ): Promise<{ netYield: string; operatorFee: string }> {
    const vaultRow = await query<{ id: number; operator_fee_bps: number }>(
      "SELECT id, operator_fee_bps FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "yield_distributed for unknown vault — skipping epoch record");
      return { netYield: yieldDist.amount.toString(), operatorFee: "0" };
    }
    const vaultId = vaultRow[0].id;
    const operatorFeeBps = vaultRow[0].operator_fee_bps ?? 0;

    const supplyRow = await query<{ total_supply: string }>(
      "SELECT total_supply FROM vaults WHERE id = $1",
      [vaultId],
    );
    const totalShares = supplyRow[0]?.total_supply ?? "0";

    const grossAmount = yieldDist.amount;
    const operatorFee = (grossAmount * BigInt(operatorFeeBps)) / 10000n;
    const netYield = grossAmount - operatorFee;

    await query(
      `INSERT INTO epochs (vault_id, epoch, yield_amount, total_shares, distributed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (vault_id, epoch) DO NOTHING`,
      [vaultId, yieldDist.epoch, yieldDist.amount.toString(), totalShares],
    );
    await this.recordTvlSnapshot(contractId);

    await query(
      `INSERT INTO share_balance_snapshots (vault_id, user_address, epoch, shares, recorded_at)
       SELECT $1, uvp.user_address, $2, uvp.shares, NOW()
       FROM user_vault_positions uvp
       WHERE uvp.vault_id = $1 AND uvp.shares > 0
       ON CONFLICT (vault_id, user_address, epoch) DO NOTHING`,
      [vaultId, yieldDist.epoch],
    );

    // #793: Fire vault.fee_earned webhook
    try {
      await this.notificationService?.notify("vault.fee_earned", {
        contractId,
        epoch: yieldDist.epoch,
        operatorFee: operatorFee.toString(),
        netYield: netYield.toString(),
      });
    } catch (e) {
      logger.warn({ err: e }, "NotificationService.notify failed for vault.fee_earned");
    }

    logger.info(
      { contractId, epoch: yieldDist.epoch, amount: yieldDist.amount.toString() },
      "Processed yield_distributed event",
    );

    sseService.broadcastEpochRecorded(contractId, {
      type: "epoch_recorded",
      contractId,
      epoch: yieldDist.epoch,
      yieldAmount: yieldDist.amount.toString(),
      timestamp: new Date(Number(yieldDist.timestamp) * 1000).toISOString(),
    });

    return { netYield: netYield.toString(), operatorFee: operatorFee.toString() };
  }

  private async handleVaultCreated(
    factoryId: string,
    vaultCreated: {
      contractId: string;
      asset: string;
      name: string;
      symbol: string;
      rwaCategory: string | null;
      fundingTarget: string | null;
      fundingDeadline: Date | null;
      minDeposit: string | null;
      maxDepositPerUser: string | null;
    },
    rawEvent?: { ledger?: number; id?: string; txHash?: string } | null,
  ): Promise<void> {
    logger.info(
      { vault: vaultCreated.contractId, factoryId, name: vaultCreated.name },
      "Processing vault_created event",
    );

    const [rwaName, rwaSymbol, rwaDocumentUri] = await Promise.all([
      readRwaName(vaultCreated.contractId),
      readRwaSymbol(vaultCreated.contractId),
      readRwaDocumentUri(vaultCreated.contractId),
    ]).catch(() => [null, null, null] as const);

    await this.vaultService.upsertVault({
      contractId: vaultCreated.contractId,
      factoryId,
      name: vaultCreated.name,
      asset: vaultCreated.asset,
      symbol: vaultCreated.symbol || null,
      state: "Funding",
      fundingTarget: vaultCreated.fundingTarget,
      fundingDeadline: vaultCreated.fundingDeadline,
      minDeposit: vaultCreated.minDeposit,
      maxDepositPerUser: vaultCreated.maxDepositPerUser,
      rwaName,
      rwaSymbol,
      rwaDocumentUri,
      rwaCategory: vaultCreated.rwaCategory,
    });

    this.watchedContractIds.add(vaultCreated.contractId);

    // Compliance trace (#1064): record where this vault came from. The insert
    // is replay-guarded so a backfill re-reading the ledger range cannot
    // produce a second entry for the same vault.
    try {
      await logSystemAudit(
        "VAULT_INDEXED",
        vaultCreated.contractId,
        {
          blockNumber: rawEvent?.ledger ?? null,
          txHash: rawEvent?.txHash ?? rawEvent?.id ?? "",
        },
        { conflictTarget: true },
      );
    } catch (e) {
      logger.warn({ err: e, vault: vaultCreated.contractId }, "Failed to write VAULT_INDEXED audit entry");
    }
  }

  private async handleCancelFunding(contractId: string): Promise<void> {
    logger.info({ contractId }, "Processing cancel_funding event");

    await this.vaultService.upsertVault({
      contractId,
      state: "Cancelled",
    });
  }

  /**
   * Persist a vault state transition emitted by a `vault_state_changed` event.
   * Updates the vault's state in the database; unknown vaults are skipped.
   */
  private async handleVaultStateChanged(
    contractId: string,
    stateChange: { oldState: string; newState: string },
  ): Promise<void> {
    if (!stateChange.newState) return;

    // #1274 – when a vault enters Matured set settlement_status to not_started
    // (no redemptions have occurred yet).  Closed vaults are fully settled.
    const settlementStatus =
      stateChange.newState === "Matured"
        ? "not_started"
        : stateChange.newState === "Closed"
          ? "complete"
          : null;

    if (stateChange.newState === "Matured") {
      // #1275 – freeze the supply at the moment of maturity so redeemedPct has
      // a fixed baseline to divide against as shares are redeemed afterwards.
      await query(
        `UPDATE vaults SET state = $1, settlement_status = $2, supply_at_maturity = total_supply, updated_at = NOW() WHERE contract_id = $3`,
        [stateChange.newState, settlementStatus, contractId],
      );
    } else if (settlementStatus !== null) {
      await query(
        `UPDATE vaults SET state = $1, settlement_status = $2, updated_at = NOW() WHERE contract_id = $3`,
        [stateChange.newState, settlementStatus, contractId],
      );
    } else {
      await query(
        `UPDATE vaults SET state = $1, updated_at = NOW() WHERE contract_id = $2`,
        [stateChange.newState, contractId],
      );
    }
    logger.info(
      { contractId, oldState: stateChange.oldState, newState: stateChange.newState },
      "Processed vault_state_changed event",
    );
  }

  /**
   * Re-derive and persist the settlement_status for a Matured vault.
   * Called after any withdrawal or redemption that may change the supply.
   * #1274
   */
  private async refreshSettlementStatus(contractId: string): Promise<void> {
    const rows = await query<{ state: string; total_supply: string }>(
      "SELECT state, total_supply FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (rows.length === 0) return;
    const { state, total_supply } = rows[0];

    if (state !== "Matured" && state !== "Closed") return; // only relevant post-maturity

    const remainingSupply = BigInt(total_supply ?? "0");
    const settlementStatus =
      remainingSupply === 0n ? "complete" : "in_progress";

    await query(
      `UPDATE vaults SET settlement_status = $1, updated_at = NOW() WHERE contract_id = $2`,
      [settlementStatus, contractId],
    );
  }

  /**
   * Mark a vault as archived (soft-deleted) when a vault_removed event is received (#674).
   * Updates archived = TRUE and updated_at in the database.
   * Idempotent — setting an already-archived vault to archived is a no-op.
   */
  private async handleVaultRemoved(contractId: string): Promise<void> {
    await query(
      `UPDATE vaults SET archived = TRUE, updated_at = NOW() WHERE contract_id = $1`,
      [contractId],
    );
    logger.info({ contractId }, "Processed vault_removed event — vault archived");
  }

  private async handleYieldClaimed(contractId: string, userAddress: string, epoch: number, amount: bigint | string = "0"): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      `SELECT id FROM vaults WHERE contract_id = $1 LIMIT 1`,
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId, userAddress, epoch }, "yield_claimed for unknown vault — skipping snapshot update");
      return;
    }

    const vaultId = vaultRow[0].id;
    const claimedAmount = typeof amount === "bigint" ? amount.toString() : String(amount ?? "0");
    await query(
      `INSERT INTO share_balance_snapshots (vault_id, user_address, epoch, shares, recorded_at, cumulative_yield_claimed)
       VALUES ($1, $2, $3, 0, NOW(), 0)
       ON CONFLICT (user_address, vault_id, epoch) DO NOTHING`,
      [vaultId, userAddress, epoch],
    );

    // Additive updates are the correctness invariant for lifetime yield totals.
    // The cumulative value must remain monotonic and atomic with the event write;
    // the duplicate replay guard in #1174 prevents the same claim from being added twice.
    await query(
      `UPDATE share_balance_snapshots
       SET cumulative_yield_claimed = cumulative_yield_claimed + $1,
           recorded_at = NOW()
       WHERE user_address = $2 AND vault_id = $3 AND epoch = $4`,
      [claimedAmount, userAddress, vaultId, epoch],
    );

    await query(
      `UPDATE user_vault_positions uvp
       SET last_claimed_epoch = GREATEST(last_claimed_epoch, $1), updated_at = NOW()
       FROM vaults v
       WHERE v.contract_id = $2
         AND uvp.vault_id = v.id
         AND uvp.user_address = $3`,
      [epoch, contractId, userAddress],
    );
    await cacheDel(`pending-yield:${contractId}:${userAddress}`);
    logger.info({ contractId, userAddress, epoch, claimedAmount }, "Processed yield_claimed event");

    // Check if epoch is now fully claimed and fire webhook (#819)
    try {
      const yieldService = new YieldService();
      const result = await yieldService.closeEpochIfFullyClaimed(contractId, epoch);
      if (result) {
        const notificationService = new NotificationService();
        await notificationService.notify("epoch.closed", {
          contractId,
          epoch,
          yieldAmount: result.epochData.yieldAmount,
          closedAt: result.epochData.closedAt,
        });
        logger.info({ contractId, epoch }, "Fired epoch.closed webhook");
      }
    } catch (err) {
      logger.warn({ contractId, epoch, err }, "Failed to check epoch close after yield claim");
    }
  }

  private async handleEarlyRedemptionProcessed(
    contractId: string,
    event: ParsedEarlyRedemptionProcessedEvent,
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "early_redemption_processed for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    // Look up the redemption request to get shares for gross-asset computation
    const reqRows = await query<{ shares: string }>(
      `SELECT shares FROM redemption_requests
       WHERE vault_id = $1 AND request_id = $2 AND processed = FALSE
       LIMIT 1`,
      [vaultId, event.requestId],
    );

    let feeRevenue = 0;
    let grossAssets = 0;

    if (reqRows.length > 0) {
      const shares = toBigIntOrZero(reqRows[0].shares);

      const vaultState = await query<{ total_assets: string; total_supply: string }>(
        "SELECT total_assets::text, total_supply::text FROM vaults WHERE id = $1",
        [vaultId],
      );

      if (vaultState.length > 0) {
        const totalAssets = toBigIntOrZero(vaultState[0].total_assets);
        const totalSupply = toBigIntOrZero(vaultState[0].total_supply);

        // Compute gross assets at current exchange rate (1:1 when no supply)
        const gross = totalSupply > 0n
          ? (shares * totalAssets) / totalSupply
          : shares;

        grossAssets = Number(gross);
        feeRevenue = grossAssets - Number(event.netAssets);
        if (feeRevenue < 0) feeRevenue = 0;
      }
    }

    await query(
      `UPDATE redemption_requests SET processed = TRUE, fee_revenue = $3, gross_assets = $4
       WHERE vault_id = $1 AND request_id = $2 AND processed = FALSE`,
      [vaultId, event.requestId, feeRevenue, grossAssets],
    );
    logger.info(
      { contractId, user: event.user, requestId: event.requestId, feeRevenue },
      "Processed early_redemption_processed event",
    );
  }

  private async handleEarlyRedemptionCancelled(
    contractId: string,
    event: ParsedEarlyRedemptionCancelledEvent,
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "early_redemption_cancelled for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    await query(
      `UPDATE redemption_requests SET processed = TRUE
       WHERE vault_id = $1 AND request_id = $2 AND processed = FALSE`,
      [vaultId, event.requestId],
    );
    logger.info(
      { contractId, user: event.user, requestId: event.requestId },
      "Processed early_redemption_cancelled event",
    );
  }

  private async handlePauseState(contractId: string, paused: boolean): Promise<void> {
    await query(
      `UPDATE vaults SET paused = $1, updated_at = NOW() WHERE contract_id = $2`,
      [paused, contractId],
    );
    logger.info({ contractId, paused }, `Processed vault ${paused ? "paused" : "unpaused"} event`);
  }

  private async handleOperatorAdded(
    contractId: string,
    event: ParsedOperatorAddedEvent,
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "op_add for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    await query(
      `INSERT INTO vault_operators (vault_id, operator, added_by, added_at)
       VALUES ($1, $2, $3, to_timestamp($4))
       ON CONFLICT (vault_id, operator)
       DO UPDATE SET
         removed_at = NULL,
         removed_by = NULL,
         added_by = EXCLUDED.added_by,
         added_at = EXCLUDED.added_at`,
      [vaultId, event.operator, event.caller, Number(event.timestamp)],
    );
    logger.info(
      { contractId, operator: event.operator },
      "Processed operator_added event",
    );
  }

  private async handleOperatorRemoved(
    contractId: string,
    event: ParsedOperatorRemovedEvent,
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "op_rem for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    await query(
      `INSERT INTO vault_operators (vault_id, operator, added_by, added_at, removed_at, removed_by)
       VALUES ($1, $2, $3, NOW(), NOW(), $4)
       ON CONFLICT (vault_id, operator)
       DO UPDATE SET
         removed_at = NOW(),
         removed_by = EXCLUDED.removed_by`,
      [vaultId, event.operator, event.caller, event.caller],
    );
    logger.info(
      { contractId, operator: event.operator },
      "Processed operator_removed event",
    );
  }

  private async handleRoleGranted(
    contractId: string,
    event: ParsedRoleGrantedEvent,
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "role_grt for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    await query(
      `INSERT INTO vault_roles (vault_id, user_address, role, granted_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (vault_id, user_address, role)
       DO UPDATE SET
         revoked_at = NULL,
         granted_at = NOW()`,
      [vaultId, event.userAddress, event.role],
    );
    logger.info(
      { contractId, user: event.userAddress, role: event.role },
      "Processed role_granted event",
    );
  }

  private async handleRoleRevoked(
    contractId: string,
    event: ParsedRoleRevokedEvent,
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "role_rvk for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    await query(
      `UPDATE vault_roles
       SET revoked_at = NOW()
       WHERE vault_id = $1 AND user_address = $2 AND role = $3 AND revoked_at IS NULL`,
      [vaultId, event.userAddress, event.role],
    );
    logger.info(
      { contractId, user: event.userAddress, role: event.role },
      "Processed role_revoked event",
    );
  }

  private async handleRequestEarlyRedemption(
    contractId: string,
    redemptionRequest: { userAddress: string; requestId: number; shares: bigint; timestamp: bigint },
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "request_early_redemption for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    // Convert timestamp (presumably in seconds) to a Date
    const requestTime = new Date(Number(redemptionRequest.timestamp) * 1000);

    await query(
      `INSERT INTO redemption_requests (vault_id, user_address, shares, request_id, request_time, processed)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       ON CONFLICT (vault_id, user_address, request_time) DO UPDATE SET request_id = EXCLUDED.request_id`,
      [vaultId, redemptionRequest.userAddress, redemptionRequest.shares.toString(), redemptionRequest.requestId, requestTime],
    );
    logger.info(
      { contractId, userAddress: redemptionRequest.userAddress, shares: redemptionRequest.shares.toString(), requestId: redemptionRequest.requestId },
      "Processed request_early_redemption event",
    );
  }

  // #790: Handle operator fee rate change event
  private async handleOperatorFeeUpdated(
    contractId: string,
    ev: { caller: string; oldFeeBps: number; newFeeBps: number },
  ): Promise<void> {
    const vaultRow = await query<{ id: number; operator_fee_bps: number }>(
      "SELECT id, operator_fee_bps FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "operator_fee_updated for unknown vault — skipping");
      return;
    }
    const vaultId = vaultRow[0].id;

    await query(
      `UPDATE vaults SET operator_fee_bps = $1, updated_at = NOW() WHERE id = $2`,
      [ev.newFeeBps, vaultId],
    );
    await query(
      `INSERT INTO vault_fee_history (vault_id, old_fee_bps, new_fee_bps, changed_by, recorded_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [vaultId, ev.oldFeeBps, ev.newFeeBps, ev.caller],
    );
    await cacheDel(`vault:${contractId}`);
    logger.info(
      { contractId, oldFeeBps: ev.oldFeeBps, newFeeBps: ev.newFeeBps },
      "Processed operator_fee_updated event",
    );
  }

  // ── #1098: handlePauseReasonSet ──────────────────────────────────────────────

  private async handlePauseReasonSet(
    contractId: string,
    ev: { caller: string; reason: string },
  ): Promise<void> {
    await query(
      `UPDATE vaults SET pause_reason = $1, updated_at = NOW() WHERE contract_id = $2`,
      [ev.reason || null, contractId],
    );
    await cacheDel(`vault:${contractId}`);
    logger.info(
      { contractId, reason: ev.reason },
      "Processed pause_reason_set event",
    );
  }

  // ── #1097: handleRedemptionQueueUpdated ──────────────────────────────────────

  private async handleRedemptionQueueUpdated(
    contractId: string,
    ev: { address: string; amount: bigint; position: number; status: string },
  ): Promise<void> {
    await query(
      `INSERT INTO redemption_queue (contract_id, address, amount, position, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (contract_id, address) DO UPDATE SET
         amount = EXCLUDED.amount,
         position = EXCLUDED.position,
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [contractId, ev.address, ev.amount.toString(), ev.position, ev.status],
    );
    logger.info(
      { contractId, address: ev.address, position: ev.position, status: ev.status },
      "Processed redemption_queue_updated event",
    );
  }

  // ── #1096: handleMinimumDepositUpdated ──────────────────────────────────────

  private async handleMinimumDepositUpdated(
    contractId: string,
    ev: { caller: string; oldMinimum: bigint; newMinimum: bigint },
  ): Promise<void> {
    await query(
      `UPDATE vaults SET minimum_deposit = $1, updated_at = NOW() WHERE contract_id = $2`,
      [ev.newMinimum.toString(), contractId],
    );
    await query(
      `INSERT INTO minimum_deposit_history (contract_id, old_minimum, new_minimum, changed_by, recorded_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [contractId, ev.oldMinimum.toString(), ev.newMinimum.toString(), ev.caller],
    );
    await cacheDel(`vault:${contractId}`);
    logger.info(
      { contractId, oldMinimum: ev.oldMinimum.toString(), newMinimum: ev.newMinimum.toString() },
      "Processed minimum_deposit_updated event",
    );
  }

  // ── #1094: handleWhitelistUpdated ───────────────────────────────────────────

  private async handleWhitelistUpdated(
    contractId: string,
    ev: { address: string; action: WhitelistAction; caller: string },
    txHash: string,
    ledger: number,
  ): Promise<void> {
    // Whitelist changes are only auditable against a known contract, so an
    // event without one is dropped rather than stored unattributably.
    if (!contractId) {
      logger.warn({ txHash, ledger }, "Dropped whitelist_updated event with no contract id");
      return;
    }

    // ON CONFLICT guards against a backfill re-reading a ledger range that was
    // already indexed — each on-chain change must produce exactly one row.
    await query(
      `INSERT INTO whitelist_events (contract_id, address, action, tx_hash, ledger)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contract_id, tx_hash, ledger, address, action) DO NOTHING`,
      [contractId, ev.address, ev.action, txHash, ledger],
    );
    logger.info(
      { contractId, address: ev.address, action: ev.action, caller: ev.caller, ledger },
      "Processed whitelist_updated event",
    );
  }

  /**
   * Apply a `vault_status_changed` event (#1065): update vaults.status and
   * append a vault_status_history row. Returns the status the vault had
   * before, or null when the vault is not indexed yet.
   */
  private async handleVaultStatusChanged(
    ev: ParsedVaultStatusChangedEvent,
    rawEvent: any,
  ): Promise<string | null> {
    const prev = await query<{ status: string }>(
      "SELECT status FROM vaults WHERE contract_id = $1",
      [ev.vault],
    );
    const previousStatus = prev[0]?.status ?? null;

    await query(
      "UPDATE vaults SET status = $1, updated_at = NOW() WHERE contract_id = $2",
      [ev.status, ev.vault],
    );
    // The history row is written even for a vault the indexer has not seen
    // yet: the on-chain transition happened and must be auditable.
    await query(
      `INSERT INTO vault_status_history
         (contract_id, event_type, previous_status, new_status, changed_at, tx_hash, ledger)
       VALUES ($1, 'status_changed', $2, $3, $4, $5, $6)
       ON CONFLICT (contract_id, event_type, tx_hash, ledger) DO NOTHING`,
      [ev.vault, previousStatus, ev.status, eventChangedAt(rawEvent), rawEvent.txHash ?? rawEvent.id ?? "", rawEvent.ledger ?? 0],
    );
    logger.info(
      { contractId: ev.vault, previousStatus, newStatus: ev.status },
      "Processed vault_status_changed event",
    );
    return previousStatus;
  }

  /**
   * Apply a `vault_manager_changed` event (#1068): update
   * vaults.manager_address and append a vault_status_history row. Returns the
   * previous manager (from the event, falling back to the stored value).
   */
  private async handleVaultManagerChanged(
    ev: ParsedVaultManagerChangedEvent,
    rawEvent: any,
  ): Promise<string | null> {
    const prev = await query<{ manager_address: string | null }>(
      "SELECT manager_address FROM vaults WHERE contract_id = $1",
      [ev.vault],
    );
    const previousManager = ev.oldManager ?? prev[0]?.manager_address ?? null;

    await query(
      "UPDATE vaults SET manager_address = $1, updated_at = NOW() WHERE contract_id = $2",
      [ev.newManager, ev.vault],
    );
    await query(
      `INSERT INTO vault_status_history
         (contract_id, event_type, previous_manager, new_manager, changed_at, tx_hash, ledger)
       VALUES ($1, 'manager_changed', $2, $3, $4, $5, $6)
       ON CONFLICT (contract_id, event_type, tx_hash, ledger) DO NOTHING`,
      [ev.vault, previousManager, ev.newManager, eventChangedAt(rawEvent), rawEvent.txHash ?? rawEvent.id ?? "", rawEvent.ledger ?? 0],
    );
    logger.info(
      { contractId: ev.vault, previousManager, newManager: ev.newManager },
      "Processed vault_manager_changed event",
    );
    return previousManager;
  }

  private async handleZkmeVerifierUpdated(
    contractId: string,
    ev: { newVerifier: string },
  ): Promise<void> {
    await query(
      `UPDATE vaults SET zkme_verifier_address = $1, updated_at = NOW()
       WHERE contract_id = $2`,
      [ev.newVerifier, contractId],
    );
    logger.info({ contractId, verifier: ev.newVerifier }, "Processed zkme_upd event");
  }

  private async handleAdminTransferred(
    ledger: number,
    ev: { oldAdmin: string; newAdmin: string },
  ): Promise<void> {
    await query(
      `INSERT INTO factory_admin_history (old_admin, new_admin, ledger, recorded_at)
       VALUES ($1, $2, $3, NOW())`,
      [ev.oldAdmin, ev.newAdmin, ledger],
    );
    logger.info({ oldAdmin: ev.oldAdmin, newAdmin: ev.newAdmin, ledger }, "Processed adm_xfr event");
  }

  private async handleWasmHashUpdated(
    ledger: number,
    ev: { oldHash: string; newHash: string; updatedBy: string },
  ): Promise<void> {
    await query(
      `INSERT INTO factory_wasm_history (old_hash, new_hash, updated_by, ledger, recorded_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ev.oldHash, ev.newHash, ev.updatedBy, ledger],
    );
    logger.info(
      { oldHash: ev.oldHash, newHash: ev.newHash, updatedBy: ev.updatedBy, ledger },
      "Processed wasm_upd event",
    );
  }

  private async handleKycSet(
    contractId: string,
    ev: { user: string; verified: boolean; timestamp: bigint },
  ): Promise<void> {
    await this.userService.upsertUser(ev.user, ev.verified);
    logger.info({ contractId, user: ev.user, verified: ev.verified }, "Processed kyc_set event");
  }

  private async handleTransfer(
    contractId: string,
    transfer: ParsedTransferEvent,
    event: any,
  ): Promise<void> {
    let vaultId: number | null = null;
    try {
      const vaultRows = await query<{ id: number }>(
        "SELECT id FROM vaults WHERE contract_id = $1",
        [contractId],
      );
      if (vaultRows.length > 0) {
        vaultId = vaultRows[0].id;
      }
    } catch (err) {
      logger.warn({ err, contractId }, "Failed to find vault for transfer");
    }

    const txHash = event.id ?? event.txHash ?? null;
    const ledger = typeof event.ledger === "number" ? event.ledger : null;
    const amountStr = transfer.amount.toString();

    // 1. Insert into transfers table
    await query(
      `INSERT INTO transfers (vault_id, from_address, to_address, amount, tx_hash, ledger, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [vaultId, transfer.from, transfer.to, amountStr, txHash, ledger],
    );

    // 2. Issue #1077: Check LARGE_TRANSFER_THRESHOLD
    try {
      const largeThreshold = BigInt(config.largeTransferThreshold);
      if (transfer.amount > largeThreshold) {
        logger.warn(
          {
            contractId,
            vaultId,
            from: transfer.from,
            to: transfer.to,
            amount: amountStr,
            threshold: largeThreshold.toString(),
          },
          "Large transfer alert: transfer amount exceeds threshold",
        );

        await query(
          `INSERT INTO transfer_alerts (vault_id, contract_id, type, amount, from_address, to_address, tx_hash, details, created_at)
           VALUES ($1, $2, 'LARGE_TRANSFER', $3, $4, $5, $6, $7, NOW())`,
          [
            vaultId,
            contractId,
            amountStr,
            transfer.from,
            transfer.to,
            txHash,
            JSON.stringify({
              threshold: largeThreshold.toString(),
              amount: amountStr,
              from: transfer.from,
              to: transfer.to,
            }),
          ],
        );
      }
    } catch (err) {
      logger.warn({ err, contractId }, "Failed to process large transfer check");
    }
  }

  private async handleTransferFeeCollected(
    contractId: string,
    feeEvent: ParsedTransferFeeCollectedEvent,
    event: any,
  ): Promise<void> {
    const txHash = event.id ?? event.txHash ?? null;
    const ledger = typeof event.ledger === "number" ? event.ledger : null;
    const feeAmountStr = feeEvent.feeAmount.toString();

    await query(
      `INSERT INTO transfer_fees (contract_id, from_address, to_address, fee_amount, tx_hash, ledger, fee_type, created_at, collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'transfer_fee', NOW(), NOW())`,
      [contractId, feeEvent.from, feeEvent.to, feeAmountStr, txHash, ledger],
    );
  }

  private async recordEvent(
    event: any,
    eventType: string,
    parsedData?: Record<string, unknown>,
  ): Promise<void> {
    const [txIndex, eventIndex] = eventPosition(event);
    await query(
      `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload, parsed_data, tx_index, event_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        event.ledger ?? 0,
        event.id ?? event.txHash ?? "",
        event.contractId ?? "",
        eventType,
        JSON.stringify(event),
        parsedData ? JSON.stringify(parsedData) : null,
        txIndex,
        eventIndex,
      ],
    );
  }

  async getLastIndexedLedger(): Promise<number> {
    const rows = await query<{ last_ledger: number }>(
      "SELECT last_ledger FROM indexer_state LIMIT 1",
    );
    return rows[0]?.last_ledger ?? config.indexer.startLedger;
  }

  async saveLastIndexedLedger(ledger: number): Promise<void> {
    await query(
      `INSERT INTO indexer_state (id, last_ledger) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = NOW()`,
      [ledger],
    );
  }

  /**
   * Configured start block (#1105): the ledger a fresh indexing run starts
   * from. `indexer_state.start_ledger` wins when set, otherwise the
   * INDEXER_START_LEDGER env var is the fallback (reported as
   * `source: "environment"`). Deliberately separate from the
   * `last_ledger` cursor so an operator can move the start block without
   * rewinding progress.
   */
  async getStartLedgerConfig(): Promise<{ startBlock: number; source: "database" | "environment" }> {
    const rows = await query<{ start_ledger: number | null }>(
      "SELECT start_ledger FROM indexer_state WHERE id = 1",
    );
    const startLedger = rows[0]?.start_ledger;
    if (startLedger === null || startLedger === undefined) {
      return { startBlock: config.indexer.startLedger, source: "environment" };
    }
    return { startBlock: startLedger, source: "database" };
  }

  async saveStartLedgerConfig(startBlock: number): Promise<void> {
    await query(
      `INSERT INTO indexer_state (id, start_ledger, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET start_ledger = EXCLUDED.start_ledger, updated_at = NOW()`,
      [startBlock],
    );
  }

  /**
   * Populate ledger_anchors every 1000 ledgers.
   */
  async recordAnchorsIfNeeded(fromLedger: number, toLedger: number, events: any[]): Promise<void> {
    const startThousand = Math.ceil(fromLedger / 1000) * 1000;
    for (let seq = startThousand; seq <= toLedger; seq += 1000) {
      if (seq <= 0) continue;
      let closedAt: Date | null = null;
      for (const ev of events) {
        if (ev.ledger === seq && typeof ev.ledgerClosedAt === "string") {
          closedAt = new Date(ev.ledgerClosedAt);
          break;
        }
      }
      if (!closedAt) {
        closedAt = new Date();
      }
      await recordLedgerAnchor(seq, closedAt);
    }
  }

  private async sleepWhileRunning(ms: number): Promise<void> {
    const stepMs = 250;
    let remaining = ms;
    while (this.running && remaining > 0) {
      const delayMs = Math.min(stepMs, remaining);
      await wait(delayMs);
      remaining -= delayMs;
    }
  }

  /**
   * Queue a backfill range to be processed on the next indexer tick.
   * For admin-triggered backfills after RPC outages.
   */
  async queueBackfill(
    fromLedger: number,
    toLedger: number,
    onProgress?: (progress: number) => Promise<void>,
  ): Promise<void> {
    if (fromLedger >= toLedger) {
      throw new Error("fromLedger must be less than toLedger");
    }
    if (toLedger - fromLedger > 10000) {
      throw new Error("Backfill range cannot exceed 10000 ledgers");
    }

    logger.info({ fromLedger, toLedger }, "Admin backfill queued");
    await this.backfill(toLedger, fromLedger, onProgress);
  }

  /**
   * Record a TVL snapshot for a vault contract.
   * Called after deposit, withdraw, or yield_distributed events.
   */
  /**
   * Return event count breakdown per contract for admin visibility (#1108).
   */
  async getEventCountsPerContract(): Promise<Array<{
    contractId: string;
    totalEvents: number;
    eventsByType: Record<string, number>;
  }>> {
    const rows = await query<{ contract_id: string; event_type: string; count: string }>(
      `SELECT contract_id, event_type, COUNT(*)::text AS count
       FROM indexed_events
       GROUP BY contract_id, event_type`,
    );

    const allContracts = new Set<string>(this.watchedContractIds);
    try {
      const vaultRows = await query<{ contract_id: string }>("SELECT contract_id FROM vaults");
      for (const v of vaultRows) allContracts.add(v.contract_id);
    } catch {
      // ignore
    }
    for (const r of rows) allContracts.add(r.contract_id);

    const contractMap = new Map<string, { totalEvents: number; eventsByType: Record<string, number> }>();
    for (const c of allContracts) {
      contractMap.set(c, { totalEvents: 0, eventsByType: {} });
    }

    for (const row of rows) {
      if (!contractMap.has(row.contract_id)) {
        contractMap.set(row.contract_id, { totalEvents: 0, eventsByType: {} });
      }
      const entry = contractMap.get(row.contract_id)!;
      const c = parseInt(row.count, 10);
      entry.eventsByType[row.event_type] = c;
      entry.totalEvents += c;
    }

    return Array.from(contractMap.entries())
      .map(([contractId, data]) => ({
        contractId,
        totalEvents: data.totalEvents,
        eventsByType: data.eventsByType,
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId));
  }

  private async recordTvlSnapshot(contractId: string): Promise<void> {
    try {
      const vaultRow = await query<{ id: number; total_assets: string; total_supply: string }>(
        "SELECT id, total_assets, total_supply FROM vaults WHERE contract_id = $1",
        [contractId],
      );
      if (vaultRow.length === 0) return;

      const { id: vaultId, total_assets: totalAssets, total_supply: totalSupply } = vaultRow[0];
      const snapshotAt = new Date();
      await query(
        `INSERT INTO vault_tvl_snapshots (vault_id, total_assets, total_supply, recorded_at)
         VALUES ($1, $2, $3, $4)`,
        [vaultId, totalAssets, totalSupply, snapshotAt],
      );

      // Emit TVL update event for GraphQL subscriptions (#1115)
      tvlPubSub.publish({
        contractId,
        tvlUsd: totalAssets,
        snapshotAt: snapshotAt.toISOString(),
      });
    } catch (err) {
      logger.warn({ err, contractId }, "Failed to record TVL snapshot");
    }
  }
}

// ── Standalone event parsers (exported for unit testing) ──────────────────────

export interface ParsedDepositEvent {
  caller: string;
  receiver: string;
  assets: bigint;
  shares: bigint;
}

export function parseDepositEvent(rawEvent: unknown): ParsedDepositEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 3 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "deposit") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const receiver = String(scValToNative(parsedTopics[2]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const assets = decodeBigInt(arr[0]);
    const shares = decodeBigInt(arr[1]);

    return { caller, receiver, assets, shares };
  } catch {
    return null;
  }
}

export interface ParsedWithdrawEvent {
  caller: string;
  receiver: string;
  owner: string;
  assets: bigint;
  shares: bigint;
}

export function parseWithdrawEvent(rawEvent: unknown): ParsedWithdrawEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 4 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "withdraw") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const receiver = String(scValToNative(parsedTopics[2]) ?? "");
    const owner = String(scValToNative(parsedTopics[3]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const assets = decodeBigInt(arr[0]);
    const shares = decodeBigInt(arr[1]);

    return { caller, receiver, owner, assets, shares };
  } catch {
    return null;
  }
}

export interface ParsedYieldDistributedEvent {
  epoch: number;
  amount: bigint;
  timestamp: bigint;
}

export function parseYieldDistributedEvent(rawEvent: unknown): ParsedYieldDistributedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "yield_dis") return null;

    const epoch = Number(scValToNative(parsedTopics[1]) ?? 0);

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const amount = decodeBigInt(arr[0]);
    const timestamp = decodeBigInt(arr[1]);

    return { epoch, amount, timestamp };
  } catch {
    return null;
  }
}

export interface ParsedEpochFinalizedEvent {
  epochId: number;
  totalYield: bigint;
  timestamp: bigint;
}

export function parseEpochFinalizedEvent(rawEvent: unknown): ParsedEpochFinalizedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    const eventName = String(scValToNative(parsedTopics[0]) ?? "");
    if (eventName !== "epoch_finalized" && eventName !== "epoch_fin") return null;

    const epochId = Number(scValToNative(parsedTopics[1]) ?? 0);
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});

    return {
      epochId,
      totalYield: decodeBigInt(arr[0]),
      timestamp: decodeBigInt(arr[1]),
    };
  } catch {
    return null;
  }
}

export function parseVaultStateChangedEvent(rawEvent: any): {
  oldState: string;
  newState: string;
} | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;

    const { topics, data } = parsed;
    let eventName = "";
    try {
      const firstTopic = typeof topics[0] === "string"
        ? xdr.ScVal.fromXDR(topics[0], "base64")
        : (topics[0] as any);
      eventName = scValToNative(firstTopic as any);
    } catch {
      return null;
    }

    if (eventName !== "st_chg" && eventName !== "vault_state_changed") return null;

    const parsedValue = typeof data === "string"
      ? xdr.ScVal.fromXDR(data, "base64")
      : data;
    const native = scValToNative(parsedValue as any) as any;
    const oldState = String(native?.oldState ?? (Array.isArray(native) ? native[0] : ""));
    const newState = String(native?.newState ?? (Array.isArray(native) ? native[1] : ""));

    return { oldState, newState };
  } catch {
    return null;
  }
}

/**
 * Parse the `rwa_upd` (a.k.a. `rwa_details_updated`) event emitted by
 * `set_rwa_details`, `set_rwa_document_uri`, and `set_expected_apy`.
 *
 * The event payload is a tuple of (name, symbol, document_uri, category,
 * expected_apy). Returns null when the event is not a metadata update so it is
 * skipped by the dispatcher (#974).
 */
export function parseMetadataUpdatedEvent(rawEvent: any): {
  name: string;
  symbol: string;
  documentUri: string;
  category: string;
  expectedApy: number;
} | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;

    const { topics, data } = parsed;
    let eventName = "";
    try {
      const firstTopic = typeof topics[0] === "string"
        ? xdr.ScVal.fromXDR(topics[0], "base64")
        : (topics[0] as any);
      eventName = scValToNative(firstTopic as any);
    } catch {
      return null;
    }

    if (eventName !== "rwa_upd" && eventName !== "rwa_details_updated") return null;

    const parsedValue = typeof data === "string"
      ? xdr.ScVal.fromXDR(data, "base64")
      : data;
    const native = scValToNative(parsedValue as any) as any;
    const name = String(native?.[0] ?? native?.name ?? "");
    const symbol = String(native?.[1] ?? native?.symbol ?? "");
    const documentUri = String(
      native?.[2] ?? native?.documentUri ?? native?.document_uri ?? "",
    );
    const category = String(native?.[3] ?? native?.category ?? "");
    const expectedApy = Number(
      native?.[4] ?? native?.expectedApy ?? native?.expected_apy ?? 0,
    );

    return { name, symbol, documentUri, category, expectedApy };
  } catch {
    return null;
  }
}

export function parseVaultCreatedEvent(rawEvent: any): {
  contractId: string;
  asset: string;
  name: string;
  symbol: string;
  rwaCategory: string | null;
  fundingTarget: string | null;
  fundingDeadline: Date | null;
  minDeposit: string | null;
  maxDepositPerUser: string | null;
} | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;

    const { topics, data } = parsed;

    const parsedTopics = topics.map((t: any) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : t,
    );
    const parsedValue = typeof data === "string"
      ? xdr.ScVal.fromXDR(data, "base64")
      : data;

    let eventName = "";
    try {
      eventName = scValToNative(parsedTopics[0]);
    } catch {
      return null;
    }

    if (eventName !== "v_create" && eventName !== "vault_created") return null;

    const contractId = String(parsedTopics[1] ?? rawEvent?.contractId ?? "");
    const nativeData = scValToNative(parsedValue as any) as any;
    const asset = String(nativeData?.asset ?? (Array.isArray(nativeData) ? nativeData[0] : "") ?? "");
    const name = String(nativeData?.name ?? (Array.isArray(nativeData) ? nativeData[1] : "") ?? "");
    const symbol = String(nativeData?.symbol ?? (Array.isArray(nativeData) ? nativeData[2] : "") ?? "");

    const rawFundingTarget = nativeData?.funding_target ?? nativeData?.fundingTarget ?? null;
    const fundingTarget = rawFundingTarget != null ? String(rawFundingTarget) : null;

    const rawFundingDeadline = nativeData?.funding_deadline ?? nativeData?.fundingDeadline ?? null;
    let fundingDeadline: Date | null = null;
    if (rawFundingDeadline != null) {
      const ts = Number(rawFundingDeadline);
      fundingDeadline = isNaN(ts) ? null : new Date(ts * 1000);
    }

    const rawMinDeposit = nativeData?.min_deposit ?? nativeData?.minDeposit ?? null;
    const minDeposit = rawMinDeposit != null ? String(rawMinDeposit) : null;

    const rawMaxDeposit = nativeData?.max_deposit_per_user ?? nativeData?.maxDepositPerUser ?? null;
    const maxDepositPerUser = rawMaxDeposit != null ? String(rawMaxDeposit) : null;

    // Extract RWA category from the first element of the data tuple (vault_type).
    // The VaultType enum is either a string or an object with a single key (the variant name).
    const rawCategory = nativeData?.rwa_category ?? nativeData?.vault_type
      ?? (Array.isArray(nativeData) ? nativeData[0] : null);
    let rwaCategory: string | null = null;
    if (typeof rawCategory === "string") {
      rwaCategory = rawCategory;
    } else if (rawCategory && typeof rawCategory === "object" && !Array.isArray(rawCategory)) {
      rwaCategory = Object.keys(rawCategory)[0] ?? null;
    }

    return { contractId, asset, name, symbol, rwaCategory, fundingTarget, fundingDeadline, minDeposit, maxDepositPerUser };
  } catch (error) {
    logger.warn({ error }, "Error parsing vault_created event");
    return null;
  }
}
export function parseCancelFundingEvent(rawEvent: any): {
  contractId: string;
} | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;

    const { topics } = parsed;

    let eventName = "";
    try {
      const firstTopic = typeof topics[0] === "string"
        ? xdr.ScVal.fromXDR(topics[0], "base64")
        : (topics[0] as any);
      eventName = scValToNative(firstTopic as any);
    } catch {
      return null;
    }

    if (eventName !== "fund_cxl" && eventName !== "funding_cancelled" && eventName !== "cancel_funding") return null;

    const contractId = String(rawEvent?.contractId ?? "");

    return { contractId };
  } catch (error) {
    logger.warn({ error }, "Error parsing cancel_funding event");
    return null;
  }
}

export interface ParsedRequestEarlyRedemptionEvent {
  userAddress: string;
  requestId: number;
  shares: bigint;
  timestamp: bigint;
}

export function parseRequestEarlyRedemptionEvent(rawEvent: unknown): ParsedRequestEarlyRedemptionEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "erq_req" && eventName !== "request_early_redemption") return null;

    const userAddress = String(scValToNative(parsedTopics[1]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const requestId = Number(decodeBigInt(arr[0]));
    const shares = decodeBigInt(arr[1]);
    const timestamp = decodeBigInt(arr[2] ?? 0n);

    return { userAddress, requestId, shares, timestamp };
  } catch {
    return null;
  }
}

export interface ParsedEarlyRedemptionProcessedEvent {
  user: string;
  requestId: number;
  netAssets: bigint;
}

export function parseEarlyRedemptionProcessedEvent(rawEvent: unknown): ParsedEarlyRedemptionProcessedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "erq_done" && eventName !== "early_redemption_processed") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const requestId = Number(decodeBigInt(arr[0]));
    const netAssets = decodeBigInt(arr[1] ?? 0n);

    return { user, requestId, netAssets };
  } catch {
    return null;
  }
}

export interface ParsedEarlyRedemptionCancelledEvent {
  user: string;
  requestId: number;
}

export function parseEarlyRedemptionCancelledEvent(rawEvent: unknown): ParsedEarlyRedemptionCancelledEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "erq_can" && eventName !== "erq_can2" && eventName !== "early_redemption_cancelled") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const requestId = Number(decodeBigInt(arr[0]));

    return { user, requestId };
  } catch {
    return null;
  }
}

// ── Issue #571: parseEarlyRedemptionRequestedEvent ────────────────────────────

export interface ParsedEarlyRedemptionRequestedEvent {
  user: string;
  requestId: number;
  shares: bigint;
  queuePosition: number;
}

export function parseEarlyRedemptionRequestedEvent(rawEvent: unknown): ParsedEarlyRedemptionRequestedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "erq_req") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const requestId = Number(arr[0] ?? 0);
    const shares = decodeBigInt(arr[1]);
    const queuePosition = Number(arr[2] ?? 0);

    return { user, requestId, shares, queuePosition };
  } catch {
    return null;
  }
}

// ── Issue #611: parseKycVerifiedEvent ─────────────────────────────────────────

export interface ParsedKycVerifiedEvent {
  user: string;
  verified: boolean;
}

/**
 * Parses a `kyc_set` on-chain event emitted when an operator updates a user's
 * KYC status.
 *
 * Expected event shape:
 *   topics[0]: symbol "kyc_set"
 *   topics[1]: account address of the user
 *   value:     bool — true = verified, false = revoked
 */
export function parseKycVerifiedEvent(rawEvent: unknown): ParsedKycVerifiedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "kyc_set") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");
    const verified = Boolean(scValToNative(parsedValue as xdr.ScVal));

    return { user, verified };
  } catch {
    return null;
  }
}

// ── Issue #569: parseYieldClaimedEvent / parseYieldClaimedPartialEvent ─────────

export interface ParsedYieldClaimedEvent {
  user: string;
  amount: bigint;
  epoch: number;
}

export function parseYieldClaimedEvent(rawEvent: unknown): ParsedYieldClaimedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "yield_clm") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const amount = decodeBigInt(arr[0]);
    const epoch = Number(arr[1] ?? 0);

    return { user, amount, epoch };
  } catch {
    return null;
  }
}

export interface ParsedYieldClaimedPartialEvent {
  user: string;
  claimed: bigint;
  shortfall: bigint;
  epoch: number;
}

export function parseYieldClaimedPartialEvent(rawEvent: unknown): ParsedYieldClaimedPartialEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "prt_yld") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const claimed = decodeBigInt(arr[0]);
    const shortfall = decodeBigInt(arr[1]);
    const epoch = Number(arr[2] ?? 0);

    return { user, claimed, shortfall, epoch };
  } catch {
    return null;
  }
}

// ── #604: parseOpAddEvent / parseOpRemEvent ────────────────────────────────────

export interface ParsedOpAddEvent {
  caller: string;
  operator: string;
  timestamp: bigint;
}

// ── Issue #606: parsePausedEvent / parseUnpausedEvent ─────────────────────────

export interface ParsedPausedEvent {
  contractId: string;
}

export function parsePausedEvent(rawEvent: any): ParsedPausedEvent | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;
    const { topics } = parsed;
    let eventName = "";
    try {
      const firstTopic = typeof topics[0] === "string"
        ? xdr.ScVal.fromXDR(topics[0], "base64")
        : (topics[0] as any);
      eventName = scValToNative(firstTopic as any);
    } catch {
      return null;
    }
    if (eventName !== "paused" && eventName !== "v_pause") return null;
    return { contractId: String(rawEvent?.contractId ?? "") };
  } catch {
    return null;
  }
}

// ── Issue #593: operator events ─────────────────────────────────────────────

export interface ParsedOperatorAddedEvent {
  caller: string;
  operator: string;
  timestamp: bigint;
}

export function parseOpAddEvent(rawEvent: unknown): ParsedOpAddEvent | null {
  return parseOperatorAddedEvent(rawEvent);
}

export function parseOperatorAddedEvent(rawEvent: unknown): ParsedOperatorAddedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 3 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "op_add") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const operator = String(scValToNative(parsedTopics[2]) ?? "");
    const timestamp = decodeBigInt(scValToNative(parsedValue as xdr.ScVal));

    return { caller, operator, timestamp };
  } catch {
    return null;
  }
}

export interface ParsedOpRemEvent {
  caller: string;
  operator: string;
  timestamp: bigint;
}

export function parseOpRemEvent(rawEvent: unknown): ParsedOpRemEvent | null {
  return parseOperatorRemovedEvent(rawEvent);
}

export interface ParsedOperatorRemovedEvent {
  caller: string;
  operator: string;
  timestamp: bigint;
  reason: string | null;
}

export function parseOperatorRemovedEvent(rawEvent: unknown): ParsedOperatorRemovedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 3 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "op_rem") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const operator = String(scValToNative(parsedTopics[2]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const timestamp = decodeBigInt(arr[0] ?? 0n);
    const reason = arr[1] != null ? String(arr[1]) : null;

    return { caller, operator, timestamp, reason };
  } catch {
    return null;
  }
}

// ── #616: parseZkmeVerifierUpdatedEvent ───────────────────────────────────────

export interface ParsedZkmeVerifierUpdatedEvent {
  caller: string;
  oldVerifier: string;
  newVerifier: string;
}

export function parseZkmeVerifierUpdatedEvent(rawEvent: unknown): ParsedZkmeVerifierUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "zkme_upd") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const oldVerifier = String(arr[0] ?? "");
    const newVerifier = String(arr[1] ?? "");

    return { caller, oldVerifier, newVerifier };
  } catch {
    return null;
  }
}

// ── Issue #839: parseAdminTransferredEvent ────────────────────────────────────

export interface ParsedAdminTransferredEvent {
  oldAdmin: string;
  newAdmin: string;
}

export function parseAdminTransferredEvent(rawEvent: unknown): ParsedAdminTransferredEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "adm_xfr" && eventName !== "admin_transferred") return null;

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const oldAdmin = String(arr[0] ?? "");
    const newAdmin = String(arr[1] ?? "");

    return { oldAdmin, newAdmin };
  } catch {
    return null;
  }
}

// ── Issue #841: parseDefaultsUpdatedEvent ─────────────────────────────────────

export interface ParsedDefaultsUpdatedEvent {
  asset: string;
  zkmeVerifier: string;
  cooperator: string;
}

export function parseDefaultsUpdatedEvent(rawEvent: unknown): ParsedDefaultsUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "def_upd" && eventName !== "defaults_updated") return null;

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const asset = String(arr[0] ?? "");
    const zkmeVerifier = String(arr[1] ?? "");
    const cooperator = String(arr[2] ?? "");

    return { asset, zkmeVerifier, cooperator };
  } catch {
    return null;
  }
}

// ── Issue #837: parseWasmHashUpdatedEvent ─────────────────────────────────────

export interface ParsedWasmHashUpdatedEvent {
  oldHash: string;
  newHash: string;
  updatedBy: string;
}

/**
 * Parse the factory's `wasm_upd` event: topics are
 * `(symbol!("wasm_upd"), updated_by)` and the value is `(old_hash, new_hash)`.
 */
export function parseWasmHashUpdatedEvent(rawEvent: unknown): ParsedWasmHashUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "wasm_upd" && eventName !== "wasm_hash_updated") return null;

    let updatedBy = "";
    if (topics.length > 1) {
      try {
        updatedBy = String(scValToNative(parsedTopics[1]) ?? "");
      } catch {
        updatedBy = "";
      }
    }

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const oldHash = normalizeHash(arr[0]);
    const newHash = normalizeHash(arr[1]);

    if (!newHash) return null;

    return { oldHash, newHash, updatedBy };
  } catch {
    return null;
  }
}

/** Render a hash ScVal as a lowercase hex string, tolerating Buffer/bytes input. */
function normalizeHash(value: unknown): string {
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) {
    try {
      return Buffer.from(value as number[]).toString("hex");
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// ── Issue #594: role events ─────────────────────────────────────────────────

export interface ParsedRoleGrantedEvent {
  userAddress: string;
  role: string;
}

export function parseRoleGrantedEvent(rawEvent: unknown): ParsedRoleGrantedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "role_grt") return null;

    const userAddress = String(scValToNative(parsedTopics[1]) ?? "");

    const nativeRole = scValToNative(parsedValue as xdr.ScVal);
    const role = typeof nativeRole === "string"
      ? nativeRole
      : String(Object.keys(nativeRole as Record<string, unknown>)[0] ?? "");

    return { userAddress, role };
  } catch {
    return null;
  }
}

// ── #612: parseKycSetEvent ────────────────────────────────────────────────────

export interface ParsedKycSetEvent {
  user: string;
  verified: boolean;
  timestamp: bigint;
}

export function parseKycSetEvent(rawEvent: unknown): ParsedKycSetEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "kyc_set") return null;

    const user = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const verified = Boolean(arr[0]);
    const timestamp = decodeBigInt(arr[1] ?? 0n);

    return { user, verified, timestamp };
  } catch {
    return null;
  }
}

export interface ParsedUnpausedEvent {
  contractId: string;
}

export function parseUnpausedEvent(rawEvent: any): ParsedUnpausedEvent | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;
    const { topics } = parsed;
    let eventName = "";
    try {
      const firstTopic = typeof topics[0] === "string"
        ? xdr.ScVal.fromXDR(topics[0], "base64")
        : (topics[0] as any);
      eventName = scValToNative(firstTopic as any);
    } catch {
      return null;
    }
    if (eventName !== "unpaused" && eventName !== "v_unpause") return null;
    return { contractId: String(rawEvent?.contractId ?? "") };
  } catch {
    return null;
  }
}

export interface ParsedRoleRevokedEvent {
  userAddress: string;
  role: string;
}

export function parseRoleRevokedEvent(rawEvent: unknown): ParsedRoleRevokedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "role_rvk") return null;

    const userAddress = String(scValToNative(parsedTopics[1]) ?? "");

    const nativeRole = scValToNative(parsedValue as xdr.ScVal);
    const role = typeof nativeRole === "string"
      ? nativeRole
      : String(Object.keys(nativeRole as Record<string, unknown>)[0] ?? "");

    return { userAddress, role };
  } catch {
    return null;
  }
}

// ── Issue #674: parseVaultRemovedEvent ────────────────────────────────────────

export interface ParsedVaultRemovedEvent {
  contractId: string;
}

/**
 * Parses a `vault_removed` or `v_rem` event emitted when a vault is removed
 * from the factory registry. Used to soft-delete (archive) vault records (#674).
 *
 * Expected event shape:
 *   topics[0]: symbol "vault_removed" or "v_rem"
 *   contractId: vault contract address in event metadata
 */
export function parseVaultRemovedEvent(rawEvent: unknown): ParsedVaultRemovedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;

    if (!Array.isArray(topics) || topics.length < 1) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }

    if (eventName !== "v_rem" && eventName !== "vault_removed") return null;

    return { contractId: String(ev["contractId"] ?? "") };
  } catch {
    return null;
  }
}

// ── #790: parseOperatorFeeUpdatedEvent ───────────────────────────────────────

export interface ParsedOperatorFeeUpdatedEvent {
  caller: string;
  oldFeeBps: number;
  newFeeBps: number;
}

export function parseOperatorFeeUpdatedEvent(rawEvent: unknown): ParsedOperatorFeeUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "fee_upd" && eventName !== "operator_fee_updated") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});
    const oldFeeBps = Number(decodeBigInt(arr[0]));
    const newFeeBps = Number(decodeBigInt(arr[1]));

    return { caller, oldFeeBps, newFeeBps };
  } catch {
    return null;
  }
}

// ── Issue #968: parseVaultNameUpdatedEvent ────────────────────────────────────

export interface ParsedVaultNameUpdatedEvent {
  caller: string;
  oldName: string;
  newName: string;
}

/**
 * Parses a `vault_name_updated` (or `v_name_upd`) on-chain event emitted when
 * an operator renames a vault after deployment.
 *
 * Expected event shape:
 *   topics[0]: symbol "vault_name_updated" or "v_name_upd"
 *   topics[1]: account address of the caller
 *   value:     tuple [old_name: string, new_name: string]
 */
export function parseVaultNameUpdatedEvent(rawEvent: unknown): ParsedVaultNameUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "vault_name_updated" && eventName !== "v_name_upd") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data)
      ? data
      : Object.values((data as Record<string, unknown>) ?? {});

    const oldName = String(arr[0] ?? "");
    const newName = String(arr[1] ?? "");

    return { caller, oldName, newName };
  } catch {
    return null;
  }
}

export interface ParsedFeeRateChangedEvent {
  feeBps: number;
  oldFeeBps: number | null;
}

/**
 * Parse the `fee_set` (a.k.a. `fee_rate_changed`) event emitted by
 * `set_early_redemption_fee`.
 *
 * The contract publishes the new fee in basis points as the event data. A
 * `(old_fee_bps, new_fee_bps)` tuple or `{ oldFeeBps, feeBps }` map is also
 * accepted so richer payloads decode without changes here. Returns null when
 * the event is not a fee rate change or the fee is out of range (0–10000 bps).
 */
export function parseFeeRateChangedEvent(rawEvent: unknown): ParsedFeeRateChangedEvent | null {
  try {
    const parsed = parseRawEventName(rawEvent);
    if (!parsed) return null;

    const { topics, data } = parsed;
    let eventName = "";
    try {
      const firstTopic = typeof topics[0] === "string"
        ? xdr.ScVal.fromXDR(topics[0], "base64")
        : (topics[0] as xdr.ScVal);
      eventName = String(scValToNative(firstTopic) ?? "");
    } catch {
      return null;
    }

    if (eventName !== "fee_set" && eventName !== "fee_rate_changed") return null;

    const parsedValue = typeof data === "string"
      ? xdr.ScVal.fromXDR(data, "base64")
      : (data as xdr.ScVal);
    const native = scValToNative(parsedValue) as unknown;

    let feeBps: number;
    let oldFeeBps: number | null = null;
    if (Array.isArray(native)) {
      if (native.length < 2) return null;
      oldFeeBps = Number(native[0]);
      feeBps = Number(native[1]);
    } else if (native !== null && typeof native === "object") {
      const obj = native as Record<string, unknown>;
      feeBps = Number(obj["feeBps"] ?? obj["fee_bps"] ?? obj["new_fee_bps"]);
      const old = obj["oldFeeBps"] ?? obj["old_fee_bps"];
      oldFeeBps = old === undefined ? null : Number(old);
    } else {
      feeBps = Number(native);
    }

    const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000;
    if (!valid(feeBps)) return null;
    if (oldFeeBps !== null && !valid(oldFeeBps)) return null;

    return { feeBps, oldFeeBps };
  } catch {
    return null;
  }
}

// ── #1098: parsePauseReasonSetEvent ──────────────────────────────────────────

export interface ParsedPauseReasonSetEvent {
  caller: string;
  reason: string;
}

export function parsePauseReasonSetEvent(rawEvent: unknown): ParsedPauseReasonSetEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "pause_reason_set") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const reason = String(Array.isArray(data) ? data[0] ?? "" : data ?? "");

    return { caller, reason };
  } catch {
    return null;
  }
}

// ── #1097: parseRedemptionQueueUpdatedEvent ──────────────────────────────────

export interface ParsedRedemptionQueueUpdatedEvent {
  address: string;
  amount: bigint;
  position: number;
  status: string;
}

export function parseRedemptionQueueUpdatedEvent(rawEvent: unknown): ParsedRedemptionQueueUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "redemption_queue_updated") return null;

    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});

    const address = String(arr[0] ?? "");
    const amount = decodeBigInt(arr[1]);
    const position = Number(decodeBigInt(arr[2]));
    const status = String(arr[3] ?? "pending");

    return { address, amount, position, status };
  } catch {
    return null;
  }
}

// ── #1096: parseMinimumDepositUpdatedEvent ──────────────────────────────────

export interface ParsedMinimumDepositUpdatedEvent {
  caller: string;
  oldMinimum: bigint;
  newMinimum: bigint;
}

export function parseMinimumDepositUpdatedEvent(rawEvent: unknown): ParsedMinimumDepositUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "minimum_deposit_updated") return null;

    const caller = String(scValToNative(parsedTopics[1]) ?? "");
    const data = scValToNative(parsedValue as xdr.ScVal);
    const arr = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {});

    const oldMinimum = decodeBigInt(arr[0]);
    const newMinimum = decodeBigInt(arr[1]);

    return { caller, oldMinimum, newMinimum };
  } catch {
    return null;
  }
}

// ── #1094: parseWhitelistUpdatedEvent ────────────────────────────────────────

export type WhitelistAction = "added" | "removed";

export interface ParsedWhitelistUpdatedEvent {
  address: string;
  action: WhitelistAction;
  caller: string;
}

/**
 * Normalise the event payload onto the two values stored in `whitelist_events`.
 *
 * A Soroban event payload reaches us either as a positional tuple or as a
 * struct, and the change may be published as a string ("added" / "removed") or
 * as a boolean allow flag, so all of those shapes are folded into the same pair
 * here. Anything else is rejected (null) rather than guessed at — a wrong action
 * in an audit table is worse than a missing event.
 */
function decodeWhitelistAction(payload: unknown): WhitelistAction | null {
  let value: unknown = payload;

  if (Array.isArray(value)) {
    value = value[0];
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const named = record["action"] ?? record["whitelisted"] ?? record["allowed"];
    value = named !== undefined ? named : Object.values(record)[0];
  }

  if (typeof value === "boolean") return value ? "added" : "removed";

  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "added":
      case "add":
      case "allow":
      case "whitelisted":
        return "added";
      case "removed":
      case "remove":
      case "revoked":
      case "denied":
        return "removed";
      default:
        return null;
    }
  }

  return null;
}

/**
 * Parse the `whitelist_updated` event emitted when a vault adds or removes an
 * address from its whitelist. `topics[0]` is the event name, `topics[1]` the
 * affected address and the optional `topics[2]` the admin that made the change.
 */
export function parseWhitelistUpdatedEvent(rawEvent: unknown): ParsedWhitelistUpdatedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 2 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "whitelist_updated") return null;

    const address = String(scValToNative(parsedTopics[1]) ?? "");
    if (!address) return null;

    const caller = topics.length > 2 ? String(scValToNative(parsedTopics[2]) ?? "") : "";

    const action = decodeWhitelistAction(scValToNative(parsedValue as xdr.ScVal));
    if (!action) return null;

    return { address, action, caller };
  } catch {
    return null;
  }
}

// ── #1065: parseVaultStatusChangedEvent ───────────────────────────────────────

export type VaultStatus = "active" | "inactive";

export interface ParsedVaultStatusChangedEvent {
  /** The vault whose status changed (not the emitting factory). */
  vault: string;
  status: VaultStatus;
}

function decodeVaultStatus(native: unknown): VaultStatus | null {
  if (typeof native === "boolean") return native ? "active" : "inactive";
  if (typeof native === "string") {
    const s = native.toLowerCase();
    return s === "active" || s === "inactive" ? s : null;
  }
  if (Array.isArray(native)) return decodeVaultStatus(native[0]);
  if (native && typeof native === "object") {
    const obj = native as Record<string, unknown>;
    return decodeVaultStatus(obj["active"] ?? obj["status"]);
  }
  return null;
}

/**
 * Parses the factory's `v_status` (a.k.a. `vault_status_changed`) event,
 * emitted by `set_vault_status`. Topics are (symbol, vault) and the data is
 * the new active flag. A vault emitting the event about itself may omit the
 * vault topic, in which case the emitting contract is the vault.
 */
export function parseVaultStatusChangedEvent(rawEvent: unknown): ParsedVaultStatusChangedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "v_status" && eventName !== "vault_status_changed") return null;

    const vault = topics.length > 1
      ? String(scValToNative(parsedTopics[1]) ?? "")
      : String(ev["contractId"] ?? "");
    if (!vault) return null;

    const status = decodeVaultStatus(scValToNative(parsedValue as xdr.ScVal));
    if (!status) return null;

    return { vault, status };
  } catch {
    return null;
  }
}

// ── #1068: parseVaultManagerChangedEvent ──────────────────────────────────────

export interface ParsedVaultManagerChangedEvent {
  /** The vault whose manager changed. */
  vault: string;
  /** Previous manager as reported by the event, or null when not emitted. */
  oldManager: string | null;
  newManager: string;
}

/**
 * Parses a `vault_manager_changed` (a.k.a. `mgr_chg`) event. The vault is the
 * contract address in topics[1] when a factory emits the event, otherwise the
 * emitting contract. The data is either (old_manager, new_manager), a struct
 * with those fields, or just the new manager address.
 */
export function parseVaultManagerChangedEvent(rawEvent: unknown): ParsedVaultManagerChangedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "vault_manager_changed" && eventName !== "mgr_chg") return null;

    // Only a contract address (C...) in topics[1] names the vault; anything
    // else there is an account and the emitting contract is the vault.
    const topicVault = topics.length > 1 ? String(scValToNative(parsedTopics[1]) ?? "") : "";
    const vault = topicVault.startsWith("C") ? topicVault : String(ev["contractId"] ?? "");
    if (!vault) return null;

    const data = scValToNative(parsedValue as xdr.ScVal) as unknown;
    let oldManager: unknown = null;
    let newManager: unknown;
    if (Array.isArray(data)) {
      [oldManager, newManager] = data.length > 1 ? data : [null, data[0]];
    } else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      oldManager = obj["old_manager"] ?? obj["oldManager"] ?? null;
      newManager = obj["new_manager"] ?? obj["newManager"];
    } else {
      newManager = data;
    }

    if (typeof newManager !== "string" || !newManager) return null;

    return {
      vault,
      oldManager: typeof oldManager === "string" && oldManager ? oldManager : null,
      newManager,
    };
  } catch {
    return null;
  }
}

export interface ParsedTransferEvent {
  from: string;
  to: string;
  amount: bigint;
}

export function parseTransferEvent(rawEvent: unknown): ParsedTransferEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 3 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "transfer") return null;

    const from = String(scValToNative(parsedTopics[1]) ?? "");
    const to = String(scValToNative(parsedTopics[2]) ?? "");
    if (!from || !to) return null;

    const data = parsedValue instanceof xdr.ScVal ? scValToNative(parsedValue) : parsedValue;
    const amount = decodeBigInt(data);

    return { from, to, amount };
  } catch {
    return null;
  }
}

export interface ParsedTransferFeeCollectedEvent {
  from: string;
  to: string;
  feeAmount: bigint;
  contractId?: string;
}

export function parseTransferFeeCollectedEvent(rawEvent: unknown): ParsedTransferFeeCollectedEvent | null {
  try {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;
    const topics = (ev["topic"] ?? ev["topics"]) as unknown[] | undefined;
    const value = ev["value"] ?? ev["data"];

    if (!Array.isArray(topics) || topics.length < 1 || value == null) return null;

    const parsedTopics = topics.map((t) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal),
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName: string;
    try {
      eventName = String(scValToNative(parsedTopics[0]) ?? "");
    } catch {
      return null;
    }
    if (eventName !== "transfer_fee_collected" && eventName !== "xfr_fee" && eventName !== "transfer_fee") {
      return null;
    }

    let from = "";
    let to = "";
    let feeAmount = 0n;

    if (parsedTopics.length >= 3) {
      from = String(scValToNative(parsedTopics[1]) ?? "");
      to = String(scValToNative(parsedTopics[2]) ?? "");
      const data = parsedValue instanceof xdr.ScVal ? scValToNative(parsedValue) : parsedValue;
      feeAmount = decodeBigInt(data);
    } else {
      const data = parsedValue instanceof xdr.ScVal ? scValToNative(parsedValue) : parsedValue;
      if (Array.isArray(data)) {
        if (data.length >= 3) {
          from = String(data[0] ?? "");
          to = String(data[1] ?? "");
          feeAmount = decodeBigInt(data[2]);
        } else if (data.length === 1) {
          feeAmount = decodeBigInt(data[0]);
        }
      } else if (data && typeof data === "object") {
        from = String((data as any).from ?? (data as any).from_address ?? (data as any).fromAddress ?? "");
        to = String((data as any).to ?? (data as any).to_address ?? (data as any).toAddress ?? "");
        feeAmount = decodeBigInt((data as any).feeAmount ?? (data as any).fee_amount ?? (data as any).amount ?? (data as any).fee ?? 0);
      } else {
        feeAmount = decodeBigInt(data);
      }
    }

    return {
      from,
      to,
      feeAmount,
      contractId: typeof ev["contractId"] === "string" ? ev["contractId"] : undefined,
    };
  } catch {
    return null;
  }
}


