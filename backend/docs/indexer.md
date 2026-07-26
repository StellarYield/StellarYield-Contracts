# Indexer Architecture

The indexer (`src/services/indexer.ts`, class `Indexer`) polls the configured Soroban RPC
endpoint for contract events emitted by watched vault contracts, turns them into typed
domain events, and writes the resulting state to Postgres. This document covers how the
poller runs, how an event goes from raw RPC payload to a DB write, and how to extend it
with a new event type. For the full topic → parser → DB-effect → webhook reference table,
see [`events.md`](./events.md); for webhook payload shapes, see [`webhooks.md`](./webhooks.md).

## Entry point

`src/index.ts` constructs a single `Indexer` instance (`indexerSingleton.ts`) and calls
`indexer.start()` once at boot (not awaited — it runs for the lifetime of the process) and
`indexer.stop()` on graceful shutdown, which just flips a `running` flag that the poll loop
checks between iterations.

## Polling loop lifecycle

`start()`:

1. Reads the last indexed ledger from the `indexer_state` table (`getLastIndexedLedger()`),
   falling back to `INDEXER_START_LEDGER` if no row exists yet.
2. If `VAULT_FACTORY_CONTRACT_ID` is not configured, the indexer runs in **state-only mode**:
   it loops calling `tickStateOnly()`, which only advances `lastLedger` to the chain tip
   without fetching or processing any events. This exists so the service still starts up
   (health checks, REST API, etc.) in environments without a factory contract deployed.
3. Otherwise, it fetches the current chain tip. If the gap between the last indexed ledger
   and the tip exceeds `INDEXER_BATCH_SIZE`, it runs a one-time `backfill()` pass before
   entering the steady-state loop (see [Backfill mechanism](#backfill-mechanism)).
4. Enters the steady-state loop: `while (running) { await tick(); await sleepWhileRunning(INDEXER_POLL_INTERVAL_MS); }`.
   `sleepWhileRunning` sleeps in 250ms steps and re-checks `running` between them, so `stop()`
   takes effect within ~250ms instead of blocking for the full poll interval.

`tick()` (one poll iteration):

1. Fetches the current chain tip ledger via RPC (wrapped in `withBackoff`, which retries
   on HTTP 429 with exponential backoff).
2. If the indexer has fallen more than `INDEXER_LAG_ALERT_LEDGERS` behind the tip, logs an
   error (alerting hook, not a hard failure).
3. If there are no new ledgers, returns early — nothing else runs.
4. Calls `server.getEvents({ startLedger, filters })`, filtered to the set of watched
   contract IDs (the factory contract plus every vault contract discovered via
   `vault_created` events), and passes each returned event to `processEvent()` in order.
5. Runs any due notification retries (`notificationService.processRetries()`).
6. Advances and persists `lastLedger` (`indexer_state.last_ledger`) — this is the resume
   point on restart.

Each tick and each `processEvent()` call opens a lightweight trace span (`startSpan`/`finishSpan`
near the top of `indexer.ts`) logged at `debug` level with a `traceId`/`spanId`/`parentSpanId`,
so a single tick and all the events it processed can be correlated in log aggregation without
a full tracing backend.

## Backfill mechanism

`backfill(tipLedger)` walks from the last indexed ledger to the chain tip in
`INDEXER_BATCH_SIZE`-ledger chunks, calling `getEvents` and `processEvent()` per chunk and
persisting `lastLedger` after each successful chunk. If an RPC call fails mid-backfill, it
stops (rather than retrying indefinitely) — `lastLedger` reflects the last successfully
completed chunk, so the next regular `tick()`/backfill will resume from there.

Backfill runs in two situations:

- **Automatically at startup**, when the gap to the chain tip exceeds `INDEXER_BATCH_SIZE`
  (e.g. after downtime).
- **On demand via the admin API** (`POST /api/v1/admin/indexer/backfill`), for recovering a
  specific ledger range after an RPC outage. This doesn't call `backfill()` directly — it
  enqueues a `pg-boss` job (`indexer-backfill`), processed by
  `indexerBackfillWorker.ts#processIndexerBackfill`, which calls `indexer.queueBackfill(from, to)`.
  Queuing (rather than an inline HTTP-triggered backfill) means the job survives an API
  process restart and the request range is capped at 10,000 ledgers.

## Event dispatch: `processEvent`

`processEvent(event, parentSpan)` is a thin span wrapper around `_processEventInner(event)`,
which does the real dispatch. It is **not** a lookup table — it's a sequential chain of
`const parsed = parseXEvent(event); if (parsed) { ...handle...; return; }` blocks, one per
event type, tried in the order they appear in the method. Each `parseXEvent` function:

- Returns `null` immediately (never throws) if the raw event's `topics[0]` symbol doesn't
  match the event name it's responsible for.
- Otherwise decodes the XDR topics/value into a typed `ParsedXEvent` object.

Because parsers are tried in sequence and each returns before the next is checked, only the
first matching parser runs for a given event — order only matters for topics that could
otherwise collide (see the note on `parseKycSetEvent` vs. `parseKycVerifiedEvent` in `events.md`).

## Deduplication

At the top of `_processEventInner`, before any parser runs:

```ts
const existing = await query(
  "SELECT id FROM indexed_events WHERE tx_hash = $1 AND contract_id = $2 AND event_type = $3 AND ledger = $4",
  [event.id ?? event.txHash ?? "", event.contractId ?? "", event.type ?? "", event.ledger ?? 0],
);
if (existing.length > 0) return;
```

This is the actual dedup guard — it's a plain `SELECT`-then-skip, not a DB constraint. Note
that the `INSERT ... ON CONFLICT DO NOTHING` used elsewhere when recording events (see
`recordEvent()`) has no matching unique index in `indexed_events`, so it never actually
triggers a conflict; it's harmless but not what prevents duplicate processing. Reprocessing
safety therefore currently depends on the indexer being single-threaded/single-instance and
processing events strictly in order — running two indexer instances against the same
database concurrently would race past this check.

## How to add a new event type

1. **Write the parser.** Add `parseXEvent(rawEvent: unknown): ParsedXEvent | null` near the
   bottom of `indexer.ts`, next to the existing parsers. Match `topics[0]`'s decoded symbol
   against your event's topic name and `return null` for anything else; decode the rest of
   the topics/value with `scValToNative` (see `parseDepositEvent` for the reference shape).
2. **Write the handler.** Add a `private async handleX(contractId, parsed)` method that
   performs the DB write(s) for this event (upsert/update the relevant table(s)).
3. **Wire it into `_processEventInner`.** Add a new block:
   ```ts
   const x = parseXEvent(event);
   if (x) {
     await this.handleX(event.contractId ?? "", x);
     await this.recordEvent(event, "x_event_type");
     // optional: await this.notificationService?.notify("x.event", {...});
     return;
   }
   ```
   `recordEvent()` writes the raw + parsed payload to `indexed_events` for audit/replay and
   increments the `indexerEventsProcessedTotal` metric — always call it (or insert into
   `indexed_events` directly, as `yield_distributed`/`yield_claimed` do when they need to
   store extra derived fields) so the event shows up in `GET /api/v1/admin/indexer` history.
4. **Notify subscribers, if relevant.** Call
   `this.notificationService?.notify("webhook.event.name", payload)` inside a `try/catch`
   (a notification failure must never fail event processing) and document the payload shape
   in [`webhooks.md`](./webhooks.md).
5. **Document it.** Add a row to the table in [`events.md`](./events.md).
6. **Test it.** Add a unit test for the parser (decode a fixture event, assert the parsed
   fields) and, if the handler has non-trivial DB logic, a test for `handleX` mocking `query`.
