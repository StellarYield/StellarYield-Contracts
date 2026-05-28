import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/index.js";
import { getSorobanRpc } from "./stellar.js";
import { VaultService } from "./vault.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBackoff<T>(
  fn: () => Promise<T>,
  retries = 5,
  startDelayMs = 1000,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 =
        err?.response?.status === 429 ||
        err?.status === 429 ||
        String(err?.message ?? "").includes("429");
      if (!is429 || attempt >= retries) throw err;
      const delayMs = Math.min(startDelayMs * Math.pow(2, attempt), 60_000);
      logger.warn(
        { attempt: attempt + 1, delayMs },
        "RPC 429 rate-limit; retrying with backoff",
      );
      await wait(delayMs);
      attempt++;
    }
  }
}

export class Indexer {
  lastLedger: number;
  private running = false;
  private vaultService: VaultService;

  constructor() {
    this.lastLedger = config.indexer.startLedger;
    this.vaultService = new VaultService();
  }

  async start(): Promise<void> {
    this.running = true;

    const rows = await query<{ last_ledger: number }>(
      "SELECT last_ledger FROM indexer_state ORDER BY id DESC LIMIT 1",
    );
    if (rows.length > 0) {
      this.lastLedger = rows[0].last_ledger;
    }

    const server = getSorobanRpc();
    const { sequence: tipLedger } = await server.getLatestLedger();
    const gap = tipLedger - this.lastLedger;

    if (gap > config.indexer.batchSize) {
      await this.backfill(tipLedger);
    }

    while (this.running) {
      await this.tick();
      await wait(config.indexer.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  async tick(): Promise<void> {
    const server = getSorobanRpc();

    let latestLedger: number;
    try {
      const resp = await withBackoff(() => server.getLatestLedger());
      latestLedger = resp.sequence;
    } catch (err) {
      logger.warn({ err }, "RPC error fetching latest ledger during tick");
      return;
    }

    if (latestLedger <= this.lastLedger) return;

    const from = this.lastLedger + 1;

    let events: any[];
    try {
      const resp = await withBackoff(() =>
        server.getEvents({ startLedger: from, filters: [] }),
      );
      events = resp.events;
    } catch (err) {
      logger.warn({ err, from, to: latestLedger }, "RPC error fetching events during tick");
      return;
    }

    logger.info(
      { from, to: latestLedger, eventCount: events.length },
      "Indexer tick complete",
    );

    for (const event of events) {
      logger.debug(
        { contractId: event.contractId, type: event.type, ledger: event.ledger },
        "Processing event",
      );
      await this.processEvent(event);
    }

    this.lastLedger = latestLedger;
    await this.persistLastLedger();
  }

  private async backfill(tipLedger: number): Promise<void> {
    const batchSize = config.indexer.batchSize;
    const server = getSorobanRpc();
    let cursor = this.lastLedger;

    while (cursor < tipLedger) {
      const batchTo = Math.min(cursor + batchSize, tipLedger);
      const remaining = tipLedger - batchTo;

      logger.info(
        { from: cursor + 1, to: batchTo, remaining },
        `Backfilling ledgers ${cursor + 1}–${batchTo} (${remaining} remaining)`,
      );

      try {
        const resp = await withBackoff(() =>
          server.getEvents({ startLedger: cursor + 1, filters: [] }),
        );

        for (const event of resp.events) {
          logger.debug(
            { contractId: event.contractId, type: event.type, ledger: event.ledger },
            "Backfill event",
          );
          await this.processEvent(event);
        }

        cursor = batchTo;
        this.lastLedger = cursor;
        await this.persistLastLedger();
      } catch (err) {
        logger.warn({ err, from: cursor + 1, to: batchTo }, "RPC error during backfill batch");
        break;
      }
    }
  }

  private async processEvent(event: any): Promise<void> {
    const existing = await query(
      "SELECT id FROM indexed_events WHERE tx_hash = $1 AND contract_id = $2 AND event_type = $3 AND ledger = $4",
      [event.id ?? event.txHash ?? "", event.contractId ?? "", event.type ?? "", event.ledger ?? 0],
    );
    if (existing.length > 0) return;

    const deposit = parseDepositEvent(event);
    if (deposit) {
      await this.handleDeposit(event.contractId ?? "", deposit);
      await this.recordEvent(event, "deposit");
      return;
    }

    const yieldDist = parseYieldDistributedEvent(event);
    if (yieldDist) {
      await this.recordEvent(event, "yield_distributed");
      return;
    }

    const vaultCreated = parseVaultCreatedEvent(event);
    if (vaultCreated) {
      await this.handleVaultCreated(vaultCreated);
      await this.recordEvent(event, "vault_created");
      return;
    }
  }

  private async handleDeposit(
    contractId: string,
    deposit: { caller: string; receiver: string; assets: bigint; shares: bigint },
  ): Promise<void> {
    await query(
      `INSERT INTO user_vault_positions (user_address, vault_id, shares, deposited, updated_at)
       SELECT $1, v.id, $2, $3, NOW()
       FROM vaults v WHERE v.contract_id = $4
       ON CONFLICT (user_address, vault_id)
       DO UPDATE SET
         shares    = user_vault_positions.shares    + EXCLUDED.shares,
         deposited = user_vault_positions.deposited + EXCLUDED.deposited,
         updated_at = NOW()`,
      [deposit.receiver, deposit.shares.toString(), deposit.assets.toString(), contractId],
    );
  }

  private async handleVaultCreated(
    vaultCreated: { factoryId: string; vault: string; vaultType: string; name: string; creator: string },
  ): Promise<void> {
    logger.info(
      { vault: vaultCreated.vault, factoryId: vaultCreated.factoryId, name: vaultCreated.name },
      "Processing vault_created event",
    );

    await this.vaultService.upsertVault({
      contractId: vaultCreated.vault,
      factoryId: vaultCreated.factoryId,
      name: vaultCreated.name,
      asset: "", // Asset will be populated later when vault details are fetched
      state: "Funding",
    });
  }

  private async recordEvent(event: any, eventType: string): Promise<void> {
    await query(
      `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        event.ledger ?? 0,
        event.id ?? event.txHash ?? "",
        event.contractId ?? "",
        eventType,
        JSON.stringify(event),
      ],
    );
  }

  private async persistLastLedger(): Promise<void> {
    await query(
      `INSERT INTO indexer_state (last_ledger, updated_at) VALUES ($1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_ledger = $1, updated_at = NOW()`,
      [this.lastLedger],
    );
  }
}

export function parseDepositEvent(rawEvent: any): {
  caller: string;
  receiver: string;
  assets: bigint;
  shares: bigint;
} | null {
  try {
    const topics = rawEvent?.topic || rawEvent?.topics;
    const value = rawEvent?.value || rawEvent?.data;

    if (!topics || topics.length < 3 || !value) return null;

    const parsedTopics = topics.map((t: any) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : t
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName = "";
    try {
      eventName = scValToNative(parsedTopics[0]);
    } catch {
      return null;
    }

    if (eventName !== "deposit") return null;

    const caller = scValToNative(parsedTopics[1]) as string;
    const receiver = scValToNative(parsedTopics[2]) as string;

    const data = scValToNative(parsedValue) as any;
    const assets = BigInt(Array.isArray(data) ? data[0] : (data?.assets ?? 0));
    const shares = BigInt(Array.isArray(data) ? data[1] : (data?.shares ?? 0));

    return { caller, receiver, assets, shares };
  } catch (error) {
    return null;
  }
}

export function parseYieldDistributedEvent(rawEvent: any): {
  epoch: number;
  amount: bigint;
  timestamp: bigint;
} | null {
  try {
    const topics = rawEvent?.topic || rawEvent?.topics;
    const value = rawEvent?.value || rawEvent?.data;

    if (!topics || topics.length < 2 || !value) return null;

    const parsedTopics = topics.map((t: any) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : t
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName = "";
    try {
      eventName = scValToNative(parsedTopics[0]);
    } catch {
      return null;
    }

    if (eventName !== "yield_dis") return null;

    const epoch = Number(scValToNative(parsedTopics[1]));

    const data = scValToNative(parsedValue) as any;
    const amount = BigInt(Array.isArray(data) ? data[0] : (data?.amount ?? 0));
    const timestamp = BigInt(Array.isArray(data) ? data[1] : (data?.timestamp ?? 0));

    return { epoch, amount, timestamp };
  } catch (error) {
    return null;
  }
}

export function parseVaultCreatedEvent(rawEvent: any): {
  factoryId: string;
  vault: string;
  vaultType: string;
  name: string;
  creator: string;
} | null {
  try {
    const topics = rawEvent?.topic || rawEvent?.topics;
    const value = rawEvent?.value || rawEvent?.data;

    if (!topics || topics.length < 2 || !value) return null;

    const parsedTopics = topics.map((t: any) =>
      typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : t
    );
    const parsedValue = typeof value === "string"
      ? xdr.ScVal.fromXDR(value, "base64")
      : value;

    let eventName = "";
    try {
      eventName = scValToNative(parsedTopics[0]);
    } catch {
      return null;
    }

    if (eventName !== "v_create") return null;

    const vault = scValToNative(parsedTopics[1]) as string;

    const data = scValToNative(parsedValue) as any;
    const vaultType = String(Array.isArray(data) ? data[0] : (data?.vaultType ?? ""));
    const name = String(Array.isArray(data) ? data[1] : (data?.name ?? ""));
    const creator = String(Array.isArray(data) ? data[2] : (data?.creator ?? ""));

    // The factory contract ID is the contractId field of the event
    const factoryId = rawEvent.contractId ?? "";

    return { factoryId, vault, vaultType, name, creator };
  } catch (error) {
    logger.warn({ error }, "Error parsing vault_created event");
    return null;
  }
}
