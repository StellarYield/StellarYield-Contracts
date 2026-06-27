import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/index.js";
import {
  getSorobanRpc,
  readRwaName,
  readRwaSymbol,
  readRwaDocumentUri,
} from "./stellar.js";
import { VaultService } from "./vault.js";
import { UserService } from "./user.js";
import { NotificationService } from "./notifications.js";
import { indexerEventsProcessedTotal, indexerLastLedger } from "./metrics.js";

// ── Upstream helpers ───────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function storeIndexedEvent(
  contractId: string,
  eventType: string,
  ev: any,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO indexed_events (ledger, tx_hash, contract_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [ev.ledger, ev.txHash, contractId, eventType, JSON.stringify(payload)],
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
      this.lastLedger = await this.getLastIndexedLedger();
      logger.info({ ledger: this.lastLedger }, `resuming from ledger ${this.lastLedger}`);

      if (!this.vaultFactoryContractId) {
        logger.info("Indexer started in state-only mode (no contract ID configured)");
        while (this.running) {
          await this.tickStateOnly();
          await this.sleepWhileRunning(config.indexer.pollIntervalMs);
        }
        return;
      }

      const server = getSorobanRpc();
      const { sequence: tipLedger } = await withBackoff(() => server.getLatestLedger());
      const gap = tipLedger - this.lastLedger;

      if (gap > config.indexer.batchSize) {
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

  private async tickStateOnly(): Promise<void> {
    const server = getSorobanRpc();

    let latestLedger: number;
    try {
      const resp = await withBackoff(() => server.getLatestLedger());
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
    logger.info({ ledger: latestLedger }, "state-only tick complete");
    this.lastTickAt = new Date();
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
    const contractIds = Array.from(this.watchedContractIds);
    const filters = contractIds.length > 0
      ? contractIds.map((id) => ({ contractIds: [id] }))
      : [];

    let events: any[];
    try {
      const resp = await withBackoff(() =>
        server.getEvents({ startLedger: from, filters }),
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

    await this.notificationService?.processRetries();

    this.lastLedger = latestLedger;
    await this.persistLastLedger();
    this.lastTickAt = new Date();
  }

  private async backfill(tipLedger: number): Promise<void> {
    const batchSize = config.indexer.batchSize;
    const server = getSorobanRpc();
    let cursor = this.lastLedger;

    const contractIds = Array.from(this.watchedContractIds);
    const filters = contractIds.length > 0
      ? contractIds.map((id) => ({ contractIds: [id] }))
      : [];

    while (cursor < tipLedger) {
      const batchTo = Math.min(cursor + batchSize, tipLedger);
      const remaining = tipLedger - batchTo;

      logger.info(
        { from: cursor + 1, to: batchTo, remaining },
        `Backfilling ledgers ${cursor + 1}–${batchTo} (${remaining} remaining)`,
      );

      try {
        const resp = await withBackoff(() =>
          server.getEvents({ startLedger: cursor + 1, filters }),
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
        this.lastTickAt = new Date();
      } catch (err) {
        logger.warn({ err, from: cursor + 1, to: batchTo }, "RPC error during backfill batch");
        break;
      }
    }
  }

  async processEvent(event: any): Promise<void> {
    const existing = await query(
      "SELECT id FROM indexed_events WHERE tx_hash = $1 AND contract_id = $2 AND event_type = $3 AND ledger = $4",
      [event.id ?? event.txHash ?? "", event.contractId ?? "", event.type ?? "", event.ledger ?? 0],
    );
    if (existing.length > 0) return;

    const deposit = parseDepositEvent(event);
    if (deposit) {
      await this.handleDeposit(event.contractId ?? "", deposit);
      await this.recordEvent(event, "deposit");
      try {
        await this.notificationService?.notify("deposit", deposit as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for deposit");
      }
      return;
    }

    const withdraw = parseWithdrawEvent(event);
    if (withdraw) {
      await this.handleWithdraw(event.contractId ?? "", withdraw);
      await this.recordEvent(event, "withdraw");
      try {
        await this.notificationService?.notify("withdraw", withdraw as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for withdraw");
      }
      return;
    }

    const yieldDist = parseYieldDistributedEvent(event);
    if (yieldDist) {
      await this.handleYieldDistributed(event.contractId ?? "", yieldDist);
      await this.recordEvent(event, "yield_distributed");
      try {
        await this.notificationService?.notify("yield_distributed", yieldDist as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for yield_distributed");
      }
      return;
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
      return;
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
      return;
    }

    const vaultCreated = parseVaultCreatedEvent(event);
    if (vaultCreated) {
      await this.handleVaultCreated(event.contractId ?? "", vaultCreated);
      await this.recordEvent(event, "vault_created");
      try {
        await this.notificationService?.notify("vault_created", vaultCreated as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for vault_created");
      }
      return;
    }

    const opAdded = parseOperatorAddedEvent(event);
    if (opAdded) {
      await this.handleOperatorAdded(event.contractId ?? "", opAdded);
      await this.recordEvent(event, "operator_added");
      return;
    }

    const opRemoved = parseOperatorRemovedEvent(event);
    if (opRemoved) {
      await this.handleOperatorRemoved(event.contractId ?? "", opRemoved);
      await this.recordEvent(event, "operator_removed");
      return;
    }

    const roleGranted = parseRoleGrantedEvent(event);
    if (roleGranted) {
      await this.handleRoleGranted(event.contractId ?? "", roleGranted);
      await this.recordEvent(event, "role_granted");
      return;
    }

    const roleRevoked = parseRoleRevokedEvent(event);
    if (roleRevoked) {
      await this.handleRoleRevoked(event.contractId ?? "", roleRevoked);
      await this.recordEvent(event, "role_revoked");
      return;
    }

    const redemptionRequest = parseRequestEarlyRedemptionEvent(event);
    if (redemptionRequest) {
      await this.handleRequestEarlyRedemption(event.contractId ?? "", redemptionRequest);
      await this.recordEvent(event, "request_early_redemption");
      try {
        await this.notificationService?.notify("request_early_redemption", redemptionRequest as any);
      } catch (e) {
        logger.warn({ err: e }, "NotificationService.notify failed for request_early_redemption");
      }
      return;
    }

    const yieldClaimed = parseYieldClaimedEvent(event);
    if (yieldClaimed) {
      await this.handleYieldClaimed(event.contractId ?? "", yieldClaimed.user, yieldClaimed.epoch);
      await this.recordEvent(event, "yield_claimed");
      return;
    }

    const yieldClaimedPartial = parseYieldClaimedPartialEvent(event);
    if (yieldClaimedPartial) {
      await this.handleYieldClaimed(event.contractId ?? "", yieldClaimedPartial.user, yieldClaimedPartial.epoch);
      await this.recordEvent(event, "yield_claimed_partial");
      return;
    }

    const earlyProcessed = parseEarlyRedemptionProcessedEvent(event);
    if (earlyProcessed) {
      await this.handleEarlyRedemptionProcessed(event.contractId ?? "", earlyProcessed);
      await this.recordEvent(event, "early_redemption_processed");
      return;
    }

    const earlyCancelled = parseEarlyRedemptionCancelledEvent(event);
    if (earlyCancelled) {
      await this.handleEarlyRedemptionCancelled(event.contractId ?? "", earlyCancelled);
      await this.recordEvent(event, "early_redemption_cancelled");
      return;
    }

    const kycUpdate = parseKycVerifiedEvent(event);
    if (kycUpdate) {
      await this.userService.upsertUser(kycUpdate.user, kycUpdate.verified);
      await this.recordEvent(event, "kyc_set");
      logger.info(
        { user: kycUpdate.user, verified: kycUpdate.verified },
        "Processed kyc_set event",
      );
      return;
    }
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
    await query(
      `UPDATE vaults SET total_shares_ever_minted = total_shares_ever_minted + $1 WHERE contract_id = $2`,
      [deposit.shares.toString(), contractId],
    );
    await this.recordTvlSnapshot(contractId);
    logger.info(
      { contractId, receiver: deposit.receiver, shares: deposit.shares.toString() },
      "Processed deposit event",
    );
  }

  private async handleWithdraw(
    contractId: string,
    withdraw: { owner: string; assets: bigint; shares: bigint },
  ): Promise<void> {
    await query(
      `INSERT INTO user_vault_positions (user_address, vault_id, shares, deposited)
       SELECT $1, v.id, 0, 0
       FROM vaults v WHERE v.contract_id = $4
       ON CONFLICT (user_address, vault_id) DO UPDATE SET
         shares    = GREATEST(0, user_vault_positions.shares    - $2),
         deposited = GREATEST(0, user_vault_positions.deposited - $3),
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
  }

  private async handleYieldDistributed(
    contractId: string,
    yieldDist: { epoch: number; amount: bigint; timestamp: bigint },
  ): Promise<void> {
    const vaultRow = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRow.length === 0) {
      logger.warn({ contractId }, "yield_distributed for unknown vault — skipping epoch record");
      return;
    }
    const vaultId = vaultRow[0].id;

    const supplyRow = await query<{ total_supply: string }>(
      "SELECT total_supply FROM vaults WHERE id = $1",
      [vaultId],
    );
    const totalShares = supplyRow[0]?.total_supply ?? "0";

    await query(
      `INSERT INTO epochs (vault_id, epoch, yield_amount, total_shares, distributed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (vault_id, epoch) DO NOTHING`,
      [vaultId, yieldDist.epoch, yieldDist.amount.toString(), totalShares],
    );
    await this.recordTvlSnapshot(contractId);
    logger.info(
      { contractId, epoch: yieldDist.epoch, amount: yieldDist.amount.toString() },
      "Processed yield_distributed event",
    );
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

    await query(
      `UPDATE vaults SET state = $1, updated_at = NOW() WHERE contract_id = $2`,
      [stateChange.newState, contractId],
    );
    logger.info(
      { contractId, oldState: stateChange.oldState, newState: stateChange.newState },
      "Processed vault_state_changed event",
    );
  }

  private async handleYieldClaimed(contractId: string, userAddress: string, epoch: number): Promise<void> {
    await query(
      `UPDATE user_vault_positions uvp
       SET last_claimed_epoch = GREATEST(last_claimed_epoch, $1), updated_at = NOW()
       FROM vaults v
       WHERE v.contract_id = $2
         AND uvp.vault_id = v.id
         AND uvp.user_address = $3`,
      [epoch, contractId, userAddress],
    );
    logger.info({ contractId, userAddress, epoch }, "Processed yield_claimed event");
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

    await query(
      `UPDATE redemption_requests SET processed = TRUE
       WHERE vault_id = $1 AND request_id = $2 AND processed = FALSE`,
      [vaultId, event.requestId],
    );
    logger.info(
      { contractId, user: event.user, requestId: event.requestId },
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
    indexerEventsProcessedTotal.inc();
  }

  private async persistLastLedger(): Promise<void> {
    await this.saveLastIndexedLedger(this.lastLedger);
    indexerLastLedger.set(this.lastLedger);
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
  async queueBackfill(fromLedger: number, toLedger: number): Promise<void> {
    if (fromLedger >= toLedger) {
      throw new Error("fromLedger must be less than toLedger");
    }
    if (toLedger - fromLedger > 10000) {
      throw new Error("Backfill range cannot exceed 10000 ledgers");
    }

    logger.info({ fromLedger, toLedger }, "Admin backfill queued");
    await this.backfill(toLedger);
  }

  /**
   * Record a TVL snapshot for a vault contract.
   * Called after deposit, withdraw, or yield_distributed events.
   */
  private async recordTvlSnapshot(contractId: string): Promise<void> {
    try {
      const vaultRow = await query<{ id: number; total_assets: string; total_supply: string }>(
        "SELECT id, total_assets, total_supply FROM vaults WHERE contract_id = $1",
        [contractId],
      );
      if (vaultRow.length === 0) return;

      const { id: vaultId, total_assets: totalAssets, total_supply: totalSupply } = vaultRow[0];
      await query(
        `INSERT INTO vault_tvl_snapshots (vault_id, total_assets, total_supply, recorded_at)
         VALUES ($1, $2, $3, NOW())`,
        [vaultId, totalAssets, totalSupply],
      );
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
    const netAssets = decodeBigInt(arr[1]);

    return { user, requestId, netAssets };
  } catch {
    return null;
  }
}

export interface ParsedEarlyRedemptionCancelledEvent {
  user: string;
  requestId: number;
  shares: bigint;
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
    const shares = decodeBigInt(arr[1]);

    return { user, requestId, shares };
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

// ── Issue #593: operator events ─────────────────────────────────────────────

export interface ParsedOperatorAddedEvent {
  caller: string;
  operator: string;
  timestamp: bigint;
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
