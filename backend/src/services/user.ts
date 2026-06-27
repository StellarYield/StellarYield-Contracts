import type {
  User,
  UserVaultPosition,
  UserPortfolioResponse,
  PaginatedResponse,
  YieldHistoryEntry,
  ShareBalanceHistoryEntry,
} from "../types/index.js";
import { query } from "../db/index.js";
import { YieldService } from "./yield.js";

export class UserService {
  async getUser(address: string): Promise<User | null> {
    const result = await query<{
      id: number;
      address: string;
      kyc_verified: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, address, kyc_verified, created_at, updated_at 
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

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
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, address, kyc_verified, created_at, updated_at 
       FROM users 
       WHERE address ILIKE $1 
       LIMIT 20`,
      [`%${search}%`],
    );

    return result.map((row) => ({
      id: row.id,
      address: row.address,
      kycVerified: row.kyc_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

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
       WHERE event_type IN ('yield_clm', 'prt_yld')
         AND (payload->>'user' = $1 OR payload->>'address' = $1)
       ORDER BY (payload->>'timestamp')::numeric DESC NULLS LAST, created_at DESC
       LIMIT $2 OFFSET $3`,
      [address, pageSize, offset],
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM indexed_events
       WHERE event_type IN ('yield_clm', 'prt_yld')
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
}
