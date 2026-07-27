import type { Epoch } from "../types/index.js";
import { query } from "../db/index.js";
import { cacheGet, cacheSet, cacheDel } from "../cache/redis.js";
import { config } from "../config.js";

const EPOCHS_CACHE_TTL = 30;
const PENDING_YIELD_CACHE_TTL = 10;

/** Yield amount range filters for the epoch list endpoint (#858). */
export interface EpochFilterOptions {
  /** Inclusive lower bound on `yield_amount`, as a non-negative integer string. */
  minYield?: string;
  /** Inclusive upper bound on `yield_amount`, as a non-negative integer string. */
  maxYield?: string;
}

export class YieldService {
  private formatYieldPerShare(yieldAmount: string, totalShares: string): string {
    const yieldBig = BigInt(yieldAmount);
    const sharesBig = BigInt(totalShares);
    if (sharesBig === BigInt(0)) return "0";
    const DECIMALS = BigInt(10) ** BigInt(18);
    const result = (yieldBig * DECIMALS) / sharesBig;
    const resultStr = result.toString();
    const padded = resultStr.padStart(19, "0");
    const integer = padded.slice(0, -18);
    const fraction = padded.slice(-18);
    return `${integer}.${fraction}`;
  }

  /**
   * Fetch all epochs for a vault, with optional yield-amount range filters.
   * Results are cached for {@link EPOCHS_CACHE_TTL} seconds.
   */
  async getVaultEpochs(contractId: string, filters: EpochFilterOptions = {}): Promise<Epoch[]> {
    const { minYield, maxYield } = filters;

    // Yield range (#858). Bounds are bound parameters cast to NUMERIC, so large
    // amounts keep full precision. Either bound may be omitted for an open-ended
    // filter. The params array stays [contractId] when neither is supplied.
    const conditions: string[] = [];
    const params: unknown[] = [contractId];
    if (minYield !== undefined) {
      params.push(minYield);
      conditions.push(`e.yield_amount >= $${params.length}::numeric`);
    }
    if (maxYield !== undefined) {
      params.push(maxYield);
      conditions.push(`e.yield_amount <= $${params.length}::numeric`);
    }
    const yieldFilterSql = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";

    // The filters are part of the cache key so a filtered result is never served
    // for a differently-filtered (or unfiltered) request. Invalidation uses the
    // `epochs:*` wildcard, which still matches these keys.
    const cacheKey = `epochs:${contractId}:${minYield ?? ""}:${maxYield ?? ""}`;
    const cached = await cacheGet<Epoch[]>(cacheKey);
    if (cached) return cached;

    const rows = await query<{
      id: number;
      vault_id: number;
      epoch: number;
      yield_amount: string;
      total_shares: string;
      distributed_at: Date | null;
      net_yield: string | null;
    }>(
      `SELECT e.id, e.vault_id, e.epoch, e.yield_amount, e.total_shares, e.distributed_at,
              (ie.payload->>'netYield') AS net_yield
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       LEFT JOIN LATERAL (
         SELECT payload FROM indexed_events
         WHERE contract_id = v.contract_id
           AND event_type = 'yield_distributed'
           AND (payload->>'epoch')::int = e.epoch
         ORDER BY created_at DESC
         LIMIT 1
       ) ie ON TRUE
       WHERE v.contract_id = $1${yieldFilterSql}
       ORDER BY e.epoch ASC`,
      params,
    );

    const epochs = rows.map((row) => ({
      id: row.id,
      vaultId: row.vault_id,
      epoch: row.epoch,
      yieldAmount: row.yield_amount,
      totalShares: row.total_shares,
      distributedAt: row.distributed_at,
      netYield: row.net_yield ?? row.yield_amount,
    }));

    await cacheSet(cacheKey, epochs, EPOCHS_CACHE_TTL);
    return epochs;
  }

  /**
   * Fetch a single epoch's detail for a vault (#815, #818).
   * Returns null if the vault or the epoch does not exist for it.
   * Includes totalClaimed/totalUnclaimed for liquidity planning.
   */
  async getEpochDetail(
    contractId: string,
    epoch: number,
  ): Promise<{
    epoch: number;
    yieldAmount: string;
    totalShares: string;
    yieldPerShare: string;
    netYield: string;
    distributedAt: string | null;
    totalClaimed: string;
    totalUnclaimed: string;
  } | null> {
    const rows = await query<{
      epoch: number;
      yield_amount: string;
      total_shares: string;
      distributed_at: Date | null;
      net_yield: string | null;
    }>(
      `SELECT e.epoch, e.yield_amount, e.total_shares, e.distributed_at,
              (ie.payload->>'netYield') AS net_yield
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       LEFT JOIN LATERAL (
         SELECT payload FROM indexed_events
         WHERE contract_id = v.contract_id
           AND event_type = 'yield_distributed'
           AND (payload->>'epoch')::int = e.epoch
         ORDER BY created_at DESC
         LIMIT 1
       ) ie ON TRUE
       WHERE v.contract_id = $1 AND e.epoch = $2`,
      [contractId, epoch],
    );

    const row = rows[0];
    if (!row) return null;

    const claimStats = await this.getEpochClaimStats(contractId, epoch);
    const totalYield = BigInt(row.yield_amount);
    const claimed = BigInt(claimStats.claimedAmount);
    const unclaimed = totalYield > claimed ? totalYield - claimed : BigInt(0);

    return {
      epoch: row.epoch,
      yieldAmount: row.yield_amount,
      totalShares: row.total_shares,
      yieldPerShare: this.formatYieldPerShare(row.yield_amount, row.total_shares),
      netYield: row.net_yield ?? row.yield_amount,
      distributedAt: row.distributed_at ? row.distributed_at.toISOString() : null,
      totalClaimed: claimed.toString(),
      totalUnclaimed: unclaimed.toString(),
    };
  }

  /**
   * Claimed amount for an epoch, summed from `yield_claimed` and
   * `yield_claimed_partial` indexed events (#816, #817).
   */
  async getEpochClaimStats(
    contractId: string,
    epoch: number,
  ): Promise<{ claimedAmount: string; uniqueClaimants: number }> {
    const rows = await query<{ claimed_amount: string; unique_claimants: string }>(
      `SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS claimed_amount,
              COUNT(DISTINCT payload->>'user')::text AS unique_claimants
       FROM indexed_events
       WHERE contract_id = $1
         AND event_type IN ('yield_claimed', 'yield_claimed_partial')
         AND (payload->>'epoch')::int = $2`,
      [contractId, epoch],
    );

    return {
      claimedAmount: rows[0]?.claimed_amount ?? "0",
      uniqueClaimants: parseInt(rows[0]?.unique_claimants ?? "0", 10),
    };
  }

  /** Derives epoch status by comparing claimed amount to the yield amount (#816). */
  deriveEpochStatus(
    yieldAmount: string,
    claimedAmount: string,
  ): "open" | "partially_claimed" | "fully_claimed" {
    const yieldBig = BigInt(yieldAmount);
    const claimedBig = BigInt(claimedAmount);
    if (claimedBig <= BigInt(0)) return "open";
    if (claimedBig >= yieldBig) return "fully_claimed";
    return "partially_claimed";
  }

  /**
   * Total holders at an epoch's snapshot, from `share_balance_snapshots` (#817).
   * Falls back to current holders with a position if no snapshot rows exist
   * for the epoch (e.g. epoch 0 before snapshots were being recorded).
   */
  async getEpochHolderCount(contractId: string, epoch: number): Promise<number> {
    const rows = await query<{ holder_count: string }>(
      `SELECT COUNT(DISTINCT sbs.user_address)::text AS holder_count
       FROM share_balance_snapshots sbs
       JOIN vaults v ON sbs.vault_id = v.id
       WHERE v.contract_id = $1 AND sbs.epoch = $2 AND sbs.shares::numeric > 0`,
      [contractId, epoch],
    );

    const holderCount = parseInt(rows[0]?.holder_count ?? "0", 10);
    if (holderCount > 0) return holderCount;

    const fallbackRows = await query<{ holder_count: string }>(
      `SELECT COUNT(*)::text AS holder_count
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE v.contract_id = $1 AND uvp.shares::numeric > 0`,
      [contractId],
    );

    return parseInt(fallbackRows[0]?.holder_count ?? "0", 10);
  }

  /**
   * Claim stats for every epoch of a vault in one query, keyed by epoch
   * number. Used by the epoch list endpoint to avoid N+1 queries (#816, #817).
   */
  async getClaimStatsForVault(
    contractId: string,
  ): Promise<Map<number, { claimedAmount: string; uniqueClaimants: number }>> {
    const rows = await query<{ epoch: number; claimed_amount: string; unique_claimants: string }>(
      `SELECT (payload->>'epoch')::int AS epoch,
              COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS claimed_amount,
              COUNT(DISTINCT payload->>'user')::text AS unique_claimants
       FROM indexed_events
       WHERE contract_id = $1
         AND event_type IN ('yield_claimed', 'yield_claimed_partial')
       GROUP BY (payload->>'epoch')::int`,
      [contractId],
    );

    const stats = new Map<number, { claimedAmount: string; uniqueClaimants: number }>();
    for (const row of rows) {
      stats.set(row.epoch, {
        claimedAmount: row.claimed_amount,
        uniqueClaimants: parseInt(row.unique_claimants, 10),
      });
    }
    return stats;
  }

  /**
   * Holder counts for every epoch snapshot of a vault in one query, keyed by
   * epoch number (#817).
   */
  async getHolderCountsForVault(contractId: string): Promise<Map<number, number>> {
    const rows = await query<{ epoch: number; holder_count: string }>(
      `SELECT sbs.epoch, COUNT(DISTINCT sbs.user_address)::text AS holder_count
       FROM share_balance_snapshots sbs
       JOIN vaults v ON sbs.vault_id = v.id
       WHERE v.contract_id = $1 AND sbs.shares::numeric > 0
       GROUP BY sbs.epoch`,
      [contractId],
    );

    const counts = new Map<number, number>();
    for (const row of rows) {
      counts.set(row.epoch, parseInt(row.holder_count, 10));
    }
    return counts;
  }

  /** participationRate = (unique claimants / total holders at snapshot) × 100, 2dp (#817). */
  calculateParticipationRate(uniqueClaimants: number, totalHolders: number): number {
    if (totalHolders <= 0) return 0;
    const rate = (uniqueClaimants / totalHolders) * 100;
    return Math.round(rate * 100) / 100;
  }

  /**
   * Compute the user's unclaimed yield across all epochs for a vault.
   *
   * @remarks BigInt arithmetic is used throughout to avoid precision loss:
   * for each unclaimed epoch, `pendingYield += (yieldAmount * userShares) / totalShares`.
   * Results are cached for {@link PENDING_YIELD_CACHE_TTL} seconds.
   */
  async getUserPendingYield(
    contractId: string,
    userAddress: string,
  ): Promise<{ pendingYield: string; epochs: number[]; claimedEpochs: number[] }> {
    const cacheKey = `pending-yield:${contractId}:${userAddress}`;
    const cached = await cacheGet<{ pendingYield: string; epochs: number[]; claimedEpochs: number[] }>(cacheKey);
    if (cached) return cached;

    const positionRows = await query<{
      shares: string;
      last_claimed_epoch: number;
    }>(
      `SELECT uvp.shares, uvp.last_claimed_epoch
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE v.contract_id = $1 AND uvp.user_address = $2`,
      [contractId, userAddress],
    );

    const position = positionRows[0];
    const lastClaimedEpoch = position?.last_claimed_epoch ?? -1;
    const shares = BigInt(position?.shares ?? "0");

    const epochRows = await query<{
      epoch: number;
      yield_amount: string;
      total_shares: string;
      expires_at: Date | null;
    }>(
      `SELECT e.epoch, e.yield_amount, e.total_shares, e.expires_at
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1
         AND (e.expires_at IS NULL OR e.expires_at > NOW())
       ORDER BY e.epoch ASC`,
      [contractId],
    );

    const pendingEpochs: number[] = [];
    const claimedEpochs: number[] = [];
    let pendingYield = BigInt(0);

    for (const row of epochRows) {
      if (row.epoch <= lastClaimedEpoch) {
        claimedEpochs.push(row.epoch);
        continue;
      }

      const totalShares = BigInt(row.total_shares);
      if (totalShares <= BigInt(0)) {
        continue;
      }

      const epochYield = (BigInt(row.yield_amount) * shares) / totalShares;
      if (epochYield > BigInt(0)) {
        pendingYield += epochYield;
        pendingEpochs.push(row.epoch);
      }
    }

    const result = {
      pendingYield: pendingYield.toString(),
      epochs: pendingEpochs,
      claimedEpochs,
    };

    await cacheSet(cacheKey, result, PENDING_YIELD_CACHE_TTL);
    return result;
  }

  /**
   * Aggregate yield metrics for a vault: total epochs, total yield distributed,
   * average yield per epoch, and estimated APY.
   */
  async getYieldSummary(contractId: string): Promise<{
    totalEpochs: string;
    totalYieldDistributed: string;
    averageYieldPerEpoch: string;
    estimatedApy: number;
  }> {
    const rows = await query<{
      total_epochs: string;
      total_yield: string;
      first_epoch_at: Date | null;
      last_epoch_at: Date | null;
      total_assets: string | null;
    }>(
      `SELECT COUNT(e.id)::text AS total_epochs,
              COALESCE(SUM(e.yield_amount::numeric), 0)::text AS total_yield,
              MIN(e.distributed_at) AS first_epoch_at,
              MAX(e.distributed_at) AS last_epoch_at,
              MAX(v.total_assets)::text AS total_assets
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1`,
      [contractId],
    );

    const totalEpochs = BigInt(rows[0]?.total_epochs ?? "0");
    const totalYield = BigInt(rows[0]?.total_yield ?? "0");
    const average = totalEpochs > BigInt(0) ? totalYield / totalEpochs : BigInt(0);

    const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
    let estimatedApy = 0;

    if (totalEpochs >= BigInt(2)) {
      const firstAt = rows[0]?.first_epoch_at;
      const lastAt = rows[0]?.last_epoch_at;
      const totalAssetsNum = Number(rows[0]?.total_assets ?? "0");
      if (firstAt && lastAt && totalAssetsNum > 0) {
        const activeDurationSeconds = (lastAt.getTime() - firstAt.getTime()) / 1000;
        if (activeDurationSeconds > 0) {
          estimatedApy =
            (Number(totalYield) / totalAssetsNum) * (SECONDS_PER_YEAR / activeDurationSeconds);
        }
      }
    }

    return {
      totalEpochs: totalEpochs.toString(),
      totalYieldDistributed: totalYield.toString(),
      averageYieldPerEpoch: average.toString(),
      estimatedApy,
    };
  }

  /**
   * Persist a yield distribution epoch. Idempotent on (vault_id, epoch)
   * conflict. Invalidates the epoch cache.
   */
  async recordEpoch(
    vaultId: number,
    epoch: number,
    yieldAmount: string,
    totalShares: string,
  ): Promise<void> {
    const expiryDays = config.yieldClaimExpiryDays;
    const expiresAt = expiryDays
      ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
      : null;

    await query(
      `INSERT INTO epochs (vault_id, epoch, yield_amount, total_shares, distributed_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (vault_id, epoch) DO NOTHING`,
      [vaultId, epoch, yieldAmount, totalShares, expiresAt],
    );
    await cacheDel(`epochs:*`);
  }

  async getEpochsBulk(
    contractId: string,
    from: number,
    to: number,
  ): Promise<Array<{ epoch: number; yieldAmount: string; totalShares: string; yieldPerShare: string; distributedAt: string | null }>> {
    const rows = await query<{
      epoch: number;
      yield_amount: string;
      total_shares: string;
      distributed_at: Date | null;
    }>(
      `SELECT e.epoch, e.yield_amount, e.total_shares, e.distributed_at
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1 AND e.epoch >= $2 AND e.epoch <= $3
       ORDER BY e.epoch ASC`,
      [contractId, from, to],
    );

    return rows.map((row) => ({
      epoch: row.epoch,
      yieldAmount: row.yield_amount,
      totalShares: row.total_shares,
      yieldPerShare: this.formatYieldPerShare(row.yield_amount, row.total_shares),
      distributedAt: row.distributed_at ? row.distributed_at.toISOString() : null,
    }));
  }

  async getYieldPerShareHistory(
    contractId: string,
    from?: Date,
    to?: Date,
    page: number = 1,
    pageSize: number = 20,
  ): Promise<{
    data: Array<{ epoch: number; yieldPerShare: string; distributedAt: string | null }>;
    total: number;
  }> {
    const offset = (page - 1) * pageSize;
    const whereConditions: string[] = ["v.contract_id = $1"];
    const params: any[] = [contractId];

    if (from) {
      whereConditions.push(`e.distributed_at >= $${params.length + 1}`);
      params.push(from);
    }
    if (to) {
      whereConditions.push(`e.distributed_at <= $${params.length + 1}`);
      params.push(to);
    }

    const whereClause = whereConditions.join(" AND ");

    const rows = await query<{
      epoch: number;
      yield_amount: string;
      total_shares: string;
      distributed_at: Date | null;
    }>(
      `SELECT e.epoch, e.yield_amount, e.total_shares, e.distributed_at
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE ${whereClause}
       ORDER BY e.epoch ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE ${whereClause}`,
      params,
    );

    const total = parseInt(countResult[0]?.count ?? "0", 10);

    const data = rows.map((row) => ({
      epoch: row.epoch,
      yieldPerShare: this.formatYieldPerShare(row.yield_amount, row.total_shares),
      distributedAt: row.distributed_at ? row.distributed_at.toISOString() : null,
    }));

    return { data, total };
  }

  // ── Epoch comparison (#820) ──────────────────────────────────────────────────
  /**
   * Compare two epochs side-by-side for a vault.
   * Returns null if either epoch does not exist.
   */
  async compareEpochs(
    contractId: string,
    epochA: number,
    epochB: number,
  ): Promise<{
    a: {
      epoch: number;
      yieldAmount: string;
      totalShares: string;
      yieldPerShare: string;
      distributedAt: string | null;
      participationRate: number;
    };
    b: {
      epoch: number;
      yieldAmount: string;
      totalShares: string;
      yieldPerShare: string;
      distributedAt: string | null;
      participationRate: number;
    };
    delta: {
      yieldAmount: string;
      yieldPerShare: string;
    };
  } | null> {
    const [rowA, rowB] = await Promise.all([
      this.getEpochDetail(contractId, epochA),
      this.getEpochDetail(contractId, epochB),
    ]);

    if (!rowA || !rowB) return null;

    const [claimA, claimB, holdersA, holdersB] = await Promise.all([
      this.getEpochClaimStats(contractId, epochA),
      this.getEpochClaimStats(contractId, epochB),
      this.getEpochHolderCount(contractId, epochA),
      this.getEpochHolderCount(contractId, epochB),
    ]);

    const participationA = this.calculateParticipationRate(claimA.uniqueClaimants, holdersA);
    const participationB = this.calculateParticipationRate(claimB.uniqueClaimants, holdersB);

    const deltaYield = BigInt(rowB.yieldAmount) - BigInt(rowA.yieldAmount);
    const deltaYps = (() => {
      const ypsA = this.parseYieldPerShare(rowA.yieldPerShare);
      const ypsB = this.parseYieldPerShare(rowB.yieldPerShare);
      return ypsB - ypsA;
    })();

    return {
      a: {
        epoch: rowA.epoch,
        yieldAmount: rowA.yieldAmount,
        totalShares: rowA.totalShares,
        yieldPerShare: rowA.yieldPerShare,
        distributedAt: rowA.distributedAt,
        participationRate: participationA,
      },
      b: {
        epoch: rowB.epoch,
        yieldAmount: rowB.yieldAmount,
        totalShares: rowB.totalShares,
        yieldPerShare: rowB.yieldPerShare,
        distributedAt: rowB.distributedAt,
        participationRate: participationB,
      },
      delta: {
        yieldAmount: deltaYield.toString(),
        yieldPerShare: deltaYps.toString(),
      },
    };
  }

  /** Parse a "X.Y" yield-per-share string back to a BigInt of scaled units. */
  private parseYieldPerShare(yps: string): bigint {
    const [intPart, fracPart = ""] = yps.split(".");
    const frac = fracPart.padEnd(18, "0").slice(0, 18);
    return BigInt(intPart + frac);
  }

  // ── Next epoch projection (#821) ────────────────────────────────────────────
  /**
   * Estimate the next epoch's yield using a rolling average of the last 3 epochs.
   * Returns null for all fields if fewer than 2 epochs exist.
   */
  async getNextEpochProjection(
    contractId: string,
  ): Promise<{
    estimatedYieldAmount: string | null;
    estimatedDistributionDate: string | null;
    basedOnEpochs: number;
  }> {
    const rows = await query<{
      epoch: number;
      yield_amount: string;
      distributed_at: Date | null;
    }>(
      `SELECT e.epoch, e.yield_amount, e.distributed_at
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1
       ORDER BY e.epoch DESC
       LIMIT 3`,
      [contractId],
    );

    if (rows.length < 2) {
      return { estimatedYieldAmount: null, estimatedDistributionDate: null, basedOnEpochs: 0 };
    }

    const epochs = rows.reverse();
    const basedOnEpochs = epochs.length;

    // Rolling average of yield amounts
    const totalYield = epochs.reduce((sum, e) => sum + BigInt(e.yield_amount), BigInt(0));
    const estimatedYieldAmount = (totalYield / BigInt(basedOnEpochs)).toString();

    // Estimate next distribution date using average interval between epochs
    let estimatedDistributionDate: string | null = null;
    const distributedDates = epochs
      .filter((e) => e.distributed_at !== null)
      .map((e) => e.distributed_at!.getTime());

    if (distributedDates.length >= 2) {
      let totalInterval = 0;
      for (let i = 1; i < distributedDates.length; i++) {
        totalInterval += distributedDates[i] - distributedDates[i - 1];
      }
      const avgIntervalMs = totalInterval / (distributedDates.length - 1);
      const lastDate = distributedDates[distributedDates.length - 1];
      estimatedDistributionDate = new Date(lastDate + avgIntervalMs).toISOString();
    }

    return { estimatedYieldAmount, estimatedDistributionDate, basedOnEpochs };
  }

  // ── Epoch close webhook (#819) ─────────────────────────────────────────────
  /**
   * After a yield claim event, check if the epoch is now fully claimed.
   * If so, set closed_at (idempotent) and return true so the caller can fire the webhook.
   */
  async closeEpochIfFullyClaimed(
    contractId: string,
    epoch: number,
  ): Promise<{ closed: true; epochData: { yieldAmount: string; closedAt: string } } | null> {
    // Check if already closed
    const existing = await query<{ closed_at: Date | null }>(
      `SELECT e.closed_at
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1 AND e.epoch = $2`,
      [contractId, epoch],
    );

    if (existing[0]?.closed_at) return null;

    const stats = await this.getEpochClaimStats(contractId, epoch);
    const detail = await this.getEpochDetail(contractId, epoch);
    if (!detail) return null;

    if (BigInt(stats.claimedAmount) < BigInt(detail.yieldAmount)) return null;

    // Set closed_at
    await query(
      `UPDATE epochs e
       SET closed_at = NOW()
       FROM vaults v
       WHERE e.vault_id = v.id
         AND v.contract_id = $1
         AND e.epoch = $2
         AND e.closed_at IS NULL`,
      [contractId, epoch],
    );

    return {
      closed: true,
      epochData: {
        yieldAmount: detail.yieldAmount,
        closedAt: new Date().toISOString(),
      },
    };
  }

  // ── Epoch yield distribution timeline (#822) ────────────────────────────────
  // Returns all epochs for a vault ordered by epoch number, optionally bounded
  // by ISO date filters on distributed_at. `totalInRange` is the exact sum of
  // all yieldAmount values in the result set.
  async getYieldTimeline(
    contractId: string,
    from?: Date,
    to?: Date,
  ): Promise<{
    points: Array<{ epoch: number; yieldAmount: string; distributedAt: string | null }>;
    totalInRange: string;
  }> {
    const conditions: string[] = ["v.contract_id = $1"];
    const params: unknown[] = [contractId];

    if (from) {
      params.push(from);
      conditions.push(`e.distributed_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`e.distributed_at <= $${params.length}`);
    }

    const where = conditions.join(" AND ");

    const rows = await query<{
      epoch: number;
      yield_amount: string;
      distributed_at: Date | null;
    }>(
      `SELECT e.epoch, e.yield_amount, e.distributed_at
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE ${where}
       ORDER BY e.epoch ASC`,
      params,
    );

    const points = rows.map((row) => ({
      epoch: row.epoch,
      yieldAmount: row.yield_amount,
      distributedAt: row.distributed_at ? row.distributed_at.toISOString() : null,
    }));

    const totalInRange = points
      .reduce((sum, p) => sum + BigInt(p.yieldAmount), 0n)
      .toString();

    return { points, totalInRange };
  }
}
