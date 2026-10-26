import type {
  User,
  UserVaultPosition,
  UserPortfolioResponse,
  PaginatedResponse,
  YieldHistoryEntry,
  ShareBalanceHistoryEntry,
  PortfolioPnlResponse,
  PortfolioPnlPosition,
  IncomeForecastResponse,
  IncomeForecastMonth,
  PortfolioAllocation,
  PortfolioAllocationResponse,
  PortfolioDiversification,
  PortfolioValueResponse,
  PortfolioHistoryEntry,
  FirstDepositResponse,
  RealizedYieldEntry,
} from "../types/index.js";
import { EventEmitter } from "node:events";
import { query } from "../db/index.js";
import { YieldService } from "./yield.js";

export class UserService {
  private emitter = new EventEmitter();

  public onPositionUpdate(
    address: string,
    callback: (position: { vaultContractId: string; shares: string; deposited: string }) => void
  ): () => void {
    const listener = (data: { address: string; vaultContractId: string; shares: string; deposited: string }) => {
      if (data.address === address) {
        callback({
          vaultContractId: data.vaultContractId,
          shares: data.shares,
          deposited: data.deposited,
        });
      }
    };
    this.emitter.on("position:updated", listener);
    return () => this.emitter.off("position:updated", listener);
  }

  public emitPositionUpdate(
    address: string,
    vaultContractId: string,
    shares: string,
    deposited: string
  ): void {
    this.emitter.emit("position:updated", { address, vaultContractId, shares, deposited });
  }

  /**
   * Look up a user by wallet address. Returns `null` if the user does not exist.
   */
  async getUser(address: string): Promise<User | null> {
    const result = await query<{
      id: number;
      address: string;
      kyc_verified: boolean;
      aml_flagged: boolean;
      aml_flagged_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, address, kyc_verified, aml_flagged, aml_flagged_at, created_at, updated_at 
       FROM users 
       WHERE address = $1
       LIMIT 1`,
      [address],
    );

    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      id: row.id,
      address: row.address,
      kycVerified: row.kyc_verified,
      amlFlagged: row.aml_flagged,
      amlFlaggedAt: row.aml_flagged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Create or update a user record. Sets `kyc_verified` on insert or update.
   */
  async upsertUser(address: string, kycVerified = false): Promise<void> {
    await query(
      `INSERT INTO users (address, kyc_verified) 
       VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE 
       SET kyc_verified = EXCLUDED.kyc_verified,
           updated_at = NOW()`,
      [address, kycVerified],
    );
  }

  /**
   * Aggregate pending yield across every vault the user has a position in.
   */
  async getTotalPendingYield(address: string): Promise<string> {
    const positions = await query<{
      contract_id: string;
    }>(
      `SELECT v.contract_id
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND uvp.shares > 0`,
      [address],
    );

    if (positions.length === 0) return "0";

    let totalPendingYield = BigInt(0);
    const yieldService = new YieldService();

    for (const row of positions) {
      const yieldData = await yieldService.getUserPendingYield(
        row.contract_id,
        address,
      );
      totalPendingYield += BigInt(yieldData.pendingYield);
    }

    return totalPendingYield.toString();
  }

  async getUserYieldSummary(address: string): Promise<{
    totalClaimed: string;
    totalPendingYield: string;
  }> {
    const claimedRows = await query<{ total_claimed: string }>(
      `SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS total_claimed
       FROM indexed_events
       WHERE event_type IN ('yield_claimed', 'yield_claimed_partial')
         AND (payload->>'user' = $1 OR payload->>'address' = $1)`,
      [address],
    );

    const totalClaimed = claimedRows[0]?.total_claimed ?? "0";
    const totalPendingYield = await this.getTotalPendingYield(address);

    return { totalClaimed, totalPendingYield };
  }

  /**
   * Per-vault yield breakdown for a user, including an annualized yield rate
   * for partial-year positions (#984).
   */
  async getUserYieldBreakdown(
    address: string,
    vaultContractId: string,
  ): Promise<{
    vaultId: string;
    deposited: string;
    realizedYield: string;
    daysSinceDeposit: number;
    annualizedYield: number | null;
  } | null> {
    const posRows = await query<{ contract_id: string; deposited: string }>(
      `SELECT v.contract_id, uvp.deposited
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND v.contract_id = $2
       LIMIT 1`,
      [address, vaultContractId],
    );
    if (posRows.length === 0) return null;

    const deposited = BigInt(posRows[0].deposited || "0");

    const claimedRows = await query<{ total: string }>(
      `SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS total
       FROM indexed_events
       WHERE event_type IN ('yield_claimed', 'yield_claimed_partial')
         AND contract_id = $2
         AND (payload->>'user' = $1 OR payload->>'address' = $1)`,
      [address, vaultContractId],
    );
    const realizedYield = BigInt(claimedRows[0]?.total ?? "0");

    // `daysSinceDeposit` is measured from the user's first recorded share
    // position in the vault (i.e. their first deposit epoch).
    const snapRows = await query<{ first_at: Date | null }>(
      `SELECT MIN(sbs.recorded_at) AS first_at
       FROM share_balance_snapshots sbs
       JOIN vaults v ON sbs.vault_id = v.id
       WHERE sbs.user_address = $1 AND v.contract_id = $2`,
      [address, vaultContractId],
    );
    const firstAt = snapRows[0]?.first_at ?? null;
    const daysSinceDeposit = firstAt
      ? Math.floor((Date.now() - firstAt.getTime()) / (24 * 60 * 60 * 1000))
      : 0;

    let annualizedYield: number | null = null;
    if (deposited > 0n && daysSinceDeposit > 0) {
      annualizedYield =
        (Number(realizedYield) / Number(deposited)) * (365 / daysSinceDeposit);
    }

    return {
      vaultId: vaultContractId,
      deposited: deposited.toString(),
      realizedYield: realizedYield.toString(),
      daysSinceDeposit,
      annualizedYield,
    };
  }

  /**
   * Fetch a user's full portfolio: all vault positions, total deposited,
   * total pending yield, and combined total value.
   */
  async getUserPortfolio(address: string): Promise<UserPortfolioResponse> {
    const positions = await query<{
      id: number;
      user_address: string;
      vault_id: number;
      contract_id: string;
      state: string;
      shares: string;
      deposited: string;
      last_claimed_epoch: number;
      updated_at: Date;
    }>(
      `SELECT uvp.id, uvp.user_address, uvp.vault_id, v.contract_id, v.state,
              uvp.shares, uvp.deposited, uvp.last_claimed_epoch, uvp.updated_at
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1
       ORDER BY uvp.deposited DESC`,
      [address],
    );

    let totalDeposited = "0";
    let totalPendingYield = BigInt(0);
    const yieldService = new YieldService();
    const transformedPositions: UserVaultPosition[] = positions.map((row) => {
      const deposited = row.deposited || "0";
      totalDeposited = (BigInt(totalDeposited) + BigInt(deposited)).toString();

      return {
        id: row.id,
        userAddress: row.user_address,
        vaultId: row.vault_id,
        contractId: row.contract_id,
        state: row.state as UserVaultPosition["state"],
        shares: row.shares || "0",
        deposited,
        lastClaimedEpoch: row.last_claimed_epoch,
        updatedAt: row.updated_at,
      };
    });

    for (const position of transformedPositions) {
      if (position.contractId) {
        const yieldData = await yieldService.getUserPendingYield(
          position.contractId,
          address,
        );
        totalPendingYield += BigInt(yieldData.pendingYield);
      }
    }

    const totalValue = (BigInt(totalDeposited) + totalPendingYield).toString();

    return {
      positions: transformedPositions,
      totalDeposited,
      totalPendingYield: totalPendingYield.toString(),
      totalValue,
    };
  }

  /** Portfolio allocation by RWA category, weighted by deposited amount (#776). */
  async getUserPortfolioAllocation(address: string): Promise<PortfolioAllocationResponse> {
    const rows = await query<{ category: string; deposited: string }>(
      `SELECT COALESCE(v.rwa_category, 'Uncategorized') AS category,
              SUM(uvp.deposited)::text AS deposited
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1
       GROUP BY COALESCE(v.rwa_category, 'Uncategorized')
       ORDER BY SUM(uvp.deposited) DESC`,
      [address],
    );

    if (rows.length === 0) {
      return { allocations: [] };
    }

    const totalDeposited = rows.reduce(
      (sum, row) => sum + BigInt(row.deposited || "0"),
      BigInt(0),
    );

    const allocations: PortfolioAllocation[] = rows.map((row) => {
      const deposited = BigInt(row.deposited || "0");
      const percentage =
        totalDeposited > 0n ? (Number(deposited) / Number(totalDeposited)) * 100 : 0;
      return {
        category: row.category,
        deposited: deposited.toString(),
        percentage,
      };
    });

    return { allocations };
  }

  /**
   * Portfolio diversification score derived from the Herfindahl-Hirschman
   * Index over per-vault deposited shares — lower HHI (spread across more
   * vaults) yields a higher score (#777).
   */
  async getUserPortfolioDiversification(address: string): Promise<PortfolioDiversification> {
    const rows = await query<{ category: string; deposited: string }>(
      `SELECT v.rwa_category AS category, uvp.deposited::text AS deposited
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND uvp.deposited::numeric > 0`,
      [address],
    );

    const vaultCount = rows.length;
    const categoryCount = new Set(rows.map((row) => row.category ?? "Uncategorized")).size;

    if (vaultCount === 0) {
      return { score: 0, vaultCount: 0, categoryCount: 0, herfindahlIndex: 0 };
    }

    const totalDeposited = rows.reduce(
      (sum, row) => sum + BigInt(row.deposited || "0"),
      BigInt(0),
    );

    const herfindahlIndex = rows.reduce((sum, row) => {
      const share = Number(BigInt(row.deposited || "0")) / Number(totalDeposited);
      return sum + share * share;
    }, 0);

    const score = Math.round((1 - herfindahlIndex) * 100 * 10) / 10;

    return { score, vaultCount, categoryCount, herfindahlIndex };
  }

  async getUserPortfolioPnl(address: string): Promise<PortfolioPnlResponse> {
    const positions = await query<{
      user_address: string;
      contract_id: string;
      shares: string;
      deposited: string;
      total_assets: string;
      total_supply: string;
    }>(
      `SELECT uvp.user_address, v.contract_id, uvp.shares, uvp.deposited,
              v.total_assets, v.total_supply
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND uvp.shares > 0
       ORDER BY uvp.deposited DESC`,
      [address],
    );

    const pnlPositions: PortfolioPnlPosition[] = positions.map((row) => {
      const deposited = BigInt(row.deposited || "0");
      const userShares = BigInt(row.shares || "0");
      const totalAssets = BigInt(Math.round(parseFloat(row.total_assets || "0")));
      const totalSupply = BigInt(Math.round(parseFloat(row.total_supply || "0")));

      const currentValue =
        userShares > 0n && totalSupply > 0n
          ? (userShares * totalAssets) / totalSupply
          : 0n;

      const gainLoss = currentValue - deposited;

      const gainLossPercent =
        deposited > 0n
          ? Number((gainLoss * 10000n) / deposited) / 100
          : 0;

      return {
        contractId: row.contract_id,
        deposited: deposited.toString(),
        currentValue: currentValue.toString(),
        gainLoss: gainLoss.toString(),
        gainLossPercent: Math.round(gainLossPercent * 100) / 100,
      };
    });

    return { positions: pnlPositions };
  }

  async getShareBalanceHistory(
    address: string,
    vaultId?: string,
  ): Promise<ShareBalanceHistoryEntry[]> {
    if (vaultId) {
      const rows = await query<{
        epoch: number;
        shares: string;
        recorded_at: Date;
      }>(
        `SELECT sbs.epoch, sbs.shares, sbs.recorded_at
         FROM share_balance_snapshots sbs
         JOIN vaults v ON sbs.vault_id = v.id
         WHERE sbs.user_address = $1 AND v.contract_id = $2
         ORDER BY sbs.epoch ASC`,
        [address, vaultId],
      );

      return rows.map((row) => ({
        epoch: row.epoch,
        shares: row.shares,
        recordedAt: row.recorded_at,
      }));
    }

    const rows = await query<{
      epoch: number;
      shares: string;
      recorded_at: Date;
    }>(
      `SELECT epoch, SUM(shares)::text AS shares, MAX(recorded_at) AS recorded_at
       FROM share_balance_snapshots
       WHERE user_address = $1
       GROUP BY epoch
       ORDER BY epoch ASC`,
      [address],
    );

    return rows.map((row) => ({
      epoch: row.epoch,
      shares: row.shares,
      recordedAt: row.recorded_at,
    }));
  }

  /**
   * Fetch portfolio positions for many users in a single query.
   *
   * Returns a map keyed by the requested address. Every requested address is
   * present in the result; addresses with no positions map to an empty array.
   */
  async getPortfoliosBatch(
    addresses: string[],
  ): Promise<Record<string, UserVaultPosition[]>> {
    // Seed the result so addresses with no positions still return an empty array.
    const result: Record<string, UserVaultPosition[]> = {};
    for (const address of addresses) {
      result[address] = [];
    }

    if (addresses.length === 0) {
      return result;
    }

    const rows = await query<{
      id: number;
      user_address: string;
      vault_id: number;
      contract_id: string;
      state: string;
      shares: string;
      deposited: string;
      last_claimed_epoch: number;
      updated_at: Date;
    }>(
      `SELECT uvp.id, uvp.user_address, uvp.vault_id, v.contract_id, v.state,
              uvp.shares, uvp.deposited, uvp.last_claimed_epoch, uvp.updated_at
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = ANY($1)
       ORDER BY uvp.deposited DESC`,
      [addresses],
    );

    for (const row of rows) {
      const position: UserVaultPosition = {
        id: row.id,
        userAddress: row.user_address,
        vaultId: row.vault_id,
        contractId: row.contract_id,
        state: row.state as UserVaultPosition["state"],
        shares: row.shares || "0",
        deposited: row.deposited || "0",
        lastClaimedEpoch: row.last_claimed_epoch,
        updatedAt: row.updated_at,
      };
      // Defensive: ANY($1) only returns requested addresses, but guard anyway.
      (result[row.user_address] ??= []).push(position);
    }

    return result;
  }

  async searchUsers(search: string): Promise<User[]> {
    const result = await query<{
      id: number;
      address: string;
      kyc_verified: boolean;
      aml_flagged: boolean;
      aml_flagged_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, address, kyc_verified, aml_flagged, aml_flagged_at, created_at, updated_at 
       FROM users 
       WHERE address ILIKE $1 
       LIMIT 20`,
      [`%${search}%`],
    );

    return result.map((row) => ({
      id: row.id,
      address: row.address,
      kycVerified: row.kyc_verified,
      amlFlagged: row.aml_flagged,
      amlFlaggedAt: row.aml_flagged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Return the total number of registered users.
   */
  async countUsers(): Promise<number> {
    const result = await query<{ count: string }>("SELECT COUNT(*) as count FROM users");
    return parseInt(result[0]?.count ?? "0", 10);
  }

  async getUserYieldHistory(
    address: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResponse<YieldHistoryEntry>> {
    const offset = (page - 1) * pageSize;

    const rows = await query<{
      contract_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT contract_id, event_type, payload, created_at
       FROM indexed_events
       WHERE event_type IN ('yield_claimed', 'yield_claimed_partial')
         AND (payload->>'user' = $1 OR payload->>'address' = $1)
       ORDER BY (payload->>'timestamp')::numeric DESC NULLS LAST, ledger DESC, tx_index DESC NULLS LAST, event_index DESC NULLS LAST, id DESC
       LIMIT $2 OFFSET $3`,
      [address, pageSize, offset],
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM indexed_events
       WHERE event_type IN ('yield_claimed', 'yield_claimed_partial')
         AND (payload->>'user' = $1 OR payload->>'address' = $1)`,
      [address],
    );

    const total = parseInt(countResult[0]?.count ?? "0", 10);

    const data: YieldHistoryEntry[] = rows.map((row) => {
      const ts = row.payload["timestamp"];
      const timestamp = ts != null
        ? new Date(Number(ts) * 1000).toISOString()
        : row.created_at.toISOString();
      const epoch = row.payload["epoch"] != null ? Number(row.payload["epoch"]) : null;

      return {
        vaultContractId: row.contract_id,
        epoch,
        amount: String(row.payload["amount"] ?? "0"),
        timestamp,
        eventType: row.event_type,
      };
    });

    return { data, total, page, pageSize };
  }

  async getUserIncomeForecast(
    address: string,
    months: number,
  ): Promise<IncomeForecastResponse> {
    const clampedMonths = Math.min(12, Math.max(1, months));

    const positions = await query<{
      vault_id: number;
      contract_id: string;
      shares: string;
    }>(
      `SELECT uvp.vault_id, v.contract_id, uvp.shares
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND uvp.shares > 0`,
      [address],
    );

    if (positions.length === 0) {
      const monthsResult: IncomeForecastMonth[] = [];
      const now = new Date();
      for (let i = 0; i < clampedMonths; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
        monthsResult.push({
          month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
          projectedYield: "0",
          vaultCount: 0,
        });
      }
      return { months: monthsResult };
    }

    const vaultIds = positions.map((p) => p.vault_id);
    const vaultPositionMap = new Map(
      positions.map((p) => [p.vault_id, { shares: BigInt(p.shares), contractId: p.contract_id }]),
    );

    // Fetch epoch data for all user vaults in one query
    const epochRows = await query<{
      vault_id: number;
      yield_amount: string;
      total_shares: string;
      distributed_at: Date;
    }>(
      `SELECT e.vault_id, e.yield_amount, e.total_shares, e.distributed_at
       FROM epochs e
       WHERE e.vault_id = ANY($1)
       ORDER BY e.distributed_at ASC`,
      [vaultIds],
    );

    // Compute average yield per month per vault
    const vaultMonthlyData = new Map<
      number,
      { avgMonthlyYield: bigint; shareRatio: number }
    >();

    const vaultEpochs = new Map<number, typeof epochRows>();
    for (const row of epochRows) {
      const list = vaultEpochs.get(row.vault_id) ?? [];
      list.push(row);
      vaultEpochs.set(row.vault_id, list);
    }

    for (const [vaultId, epochs] of vaultEpochs) {
      if (epochs.length === 0) continue;

      const position = vaultPositionMap.get(vaultId);
      if (!position || position.shares === 0n) continue;

      const firstEpoch = epochs[0].distributed_at;
      const lastEpoch = epochs[epochs.length - 1].distributed_at;

      const totalYield = epochs.reduce(
        (sum, e) => sum + BigInt(e.yield_amount),
        0n,
      );

      // Time span in months
      const spanMs = lastEpoch.getTime() - firstEpoch.getTime();
      const spanMonths = Math.max(spanMs / (30.44 * 24 * 60 * 60 * 1000), 1);

      const avgMonthlyYield = totalYield / BigInt(Math.round(spanMonths));

      // Compute user's share ratio for this vault
      const latestTotalShares = BigInt(
        epochs[epochs.length - 1].total_shares,
      );
      const shareRatio =
        latestTotalShares > 0n
          ? Number((position.shares * 10000n) / latestTotalShares) / 10000
          : 0;

      vaultMonthlyData.set(vaultId, { avgMonthlyYield, shareRatio });
    }

    // Project yield for each month
    const monthsResult: IncomeForecastMonth[] = [];
    const now = new Date();

    for (let i = 0; i < clampedMonths; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      let totalProjected = 0n;
      let vaultCount = 0;

      for (const [_vaultId, data] of vaultMonthlyData) {
        const userMonthlyYield =
          BigInt(Math.round(Number(data.avgMonthlyYield) * data.shareRatio));
        if (userMonthlyYield > 0n) {
          totalProjected += userMonthlyYield;
          vaultCount++;
        }
      }

      monthsResult.push({
        month: monthStr,
        projectedYield: totalProjected.toString(),
        vaultCount,
      });
    }

    return { months: monthsResult };
  }

  /**
   * Get user portfolio value with USD calculations based on latest TVL per share.
   * #1079
   */
  async getUserPortfolioValue(address: string): Promise<PortfolioValueResponse> {
    const positions = await query<{
      contract_id: string;
      shares: string;
      total_assets: string;
      total_supply: string;
    }>(
      `SELECT v.contract_id, uvp.shares, v.total_assets, v.total_supply
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE uvp.user_address = $1 AND uvp.shares > 0`,
      [address],
    );

    const transformedPositions = positions.map((row) => {
      const shares = BigInt(row.shares || "0");
      const totalAssets = BigInt(Math.round(parseFloat(row.total_assets || "0")));
      const totalSupply = BigInt(Math.round(parseFloat(row.total_supply || "0")));

      const tvlPerShare = totalSupply > 0n ? totalAssets / totalSupply : 0n;
      const valueUsd = shares * tvlPerShare;
      const shareOfVault = totalSupply > 0n ? Number(shares) / Number(totalSupply) : 0;

      return {
        contractId: row.contract_id,
        shares: row.shares,
        valueUsd: valueUsd.toString(),
        shareOfVault,
      };
    });

    const totalValueUsd = transformedPositions.reduce(
      (sum, pos) => sum + BigInt(pos.valueUsd),
      BigInt(0),
    ).toString();

    return {
      address,
      totalValueUsd,
      positions: transformedPositions,
    };
  }

  /**
   * Get user portfolio history time-series.
   * #1080
   */
  async getUserPortfolioHistory(
    address: string,
    from: Date,
    to: Date,
    interval: "1d" | "7d",
  ): Promise<PortfolioHistoryEntry[]> {
    const intervalDays = interval === "1d" ? 1 : 7;
    const points: PortfolioHistoryEntry[] = [];

    const startDate = new Date(from);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(to);
    endDate.setHours(23, 59, 59, 999);

    for (let current = new Date(startDate); current <= endDate; current.setDate(current.getDate() + intervalDays)) {
      const dateStr = current.toISOString().split("T")[0];

      const snapshots = await query<{
        shares: string;
        total_assets: string;
        total_supply: string;
      }>(
        `SELECT sbs.shares, tvl.total_assets, tvl.total_supply
         FROM share_balance_snapshots sbs
         JOIN vault_tvl_snapshots tvl ON sbs.vault_id = tvl.vault_id
         WHERE sbs.user_address = $1
           AND sbs.recorded_at <= $2
           AND tvl.recorded_at <= $2
         ORDER BY sbs.recorded_at DESC, tvl.recorded_at DESC
         LIMIT 1`,
        [address, current],
      );

      if (snapshots.length === 0) {
        points.push({ date: dateStr, totalValueUsd: "0" });
        continue;
      }

      const snapshot = snapshots[0];
      const shares = BigInt(snapshot.shares || "0");
      const totalAssets = BigInt(Math.round(parseFloat(snapshot.total_assets || "0")));
      const totalSupply = BigInt(Math.round(parseFloat(snapshot.total_supply || "0")));

      const tvlPerShare = totalSupply > 0n ? totalAssets / totalSupply : 0n;
      const valueUsd = shares * tvlPerShare;

      points.push({ date: dateStr, totalValueUsd: valueUsd.toString() });
    }

    return points;
  }

  /**
   * Get user first deposit date and vault.
   * #1081
   */
  async getUserFirstDeposit(address: string): Promise<FirstDepositResponse | null> {
    const result = await query<{
      contract_id: string;
      created_at: Date;
    }>(
      `SELECT ie.contract_id, ie.created_at
       FROM indexed_events ie
       WHERE ie.event_type = 'deposit'
         AND (ie.payload->>'caller' = $1 OR ie.payload->>'receiver' = $1)
       ORDER BY ie.ledger ASC, ie.tx_index ASC NULLS LAST, ie.event_index ASC NULLS LAST, ie.id ASC
       LIMIT 1`,
      [address],
    );

    if (result.length === 0) {
      return null;
    }

    return {
      address,
      firstDepositAt: result[0].created_at,
      contractId: result[0].contract_id,
    };
  }

  /**
   * Get user realized yield history.
   * #1082
   */
  async getUserRealizedYield(
    address: string,
    from?: Date,
    to?: Date,
  ): Promise<RealizedYieldEntry[]> {
    let queryStr = `
      SELECT contract_id, payload, created_at
      FROM indexed_events
      WHERE event_type IN ('yield_claimed', 'yield_claimed_partial')
        AND (payload->>'user' = $1 OR payload->>'address' = $1)
    `;
    const params: (string | Date)[] = [address];

    if (from) {
      queryStr += ` AND created_at >= $${params.length + 1}`;
      params.push(from);
    }

    if (to) {
      queryStr += ` AND created_at <= $${params.length + 1}`;
      params.push(to);
    }

    queryStr += ` ORDER BY ledger DESC, tx_index DESC NULLS LAST, event_index DESC NULLS LAST, id DESC`;

    const rows = await query<{
      contract_id: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(queryStr, params);

    return rows.map((row) => ({
      contractId: row.contract_id,
      epochId: Number(row.payload["epoch"] ?? 0),
      yieldClaimed: String(row.payload["amount"] ?? "0"),
      claimedAt: row.created_at,
    }));
  }
}
