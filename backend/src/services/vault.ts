import type { Vault, UserVaultPosition, PaginatedResponse } from "../types/index.js";
import { query } from "../db/index.js";
import { logger } from "../logger.js";

interface ListVaultsOptions {
  page: number;
  pageSize: number;
  state?: string;
  sort: "created_at" | "total_assets";
  order: "asc" | "desc";
}

interface VaultRow {
  id: number;
  contract_id: string;
  factory_id: string | null;
  asset: string;
  name: string | null;
  symbol: string | null;
  state: string;
  total_assets: string;
  total_supply: string;
  total_shares_ever_minted: string;
  total_shares_ever_burned: string;
  depositor_count: number;
  funding_target: string | null;
  funding_deadline: Date | null;
  min_deposit: string | null;
  max_deposit_per_user: string | null;
  created_at: Date;
  updated_at: Date;
}

function computeFundingProgress(totalAssets: string, fundingTarget: string | null): number | null {
  if (!fundingTarget) return null;
  const target = parseFloat(fundingTarget);
  if (!target) return 0;
  return Math.min(100, (parseFloat(totalAssets) / target) * 100);
}

function mapVaultRow(row: VaultRow): Vault {
  return {
    id: row.id,
    contractId: row.contract_id,
    factoryId: row.factory_id,
    asset: row.asset,
    name: row.name,
    symbol: row.symbol,
    state: row.state as any,
    // Defensive fallback: row.total_assets should always be non-null after the
    // COALESCE in the query, but guard here too in case of raw inserts (#499).
    totalAssets: row.total_assets ?? "0",
    totalSupply: row.total_supply ?? "0",
    totalSharesEverMinted: row.total_shares_ever_minted ?? "0",
    totalSharesEverBurned: row.total_shares_ever_burned ?? "0",
    depositorCount: row.depositor_count,
    fundingTarget: row.funding_target,
    fundingDeadline: row.funding_deadline,
    fundingProgress: computeFundingProgress(row.total_assets, row.funding_target),
    minDeposit: row.min_deposit,
    maxDepositPerUser: row.max_deposit_per_user,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class VaultService {
  async listVaults(opts: ListVaultsOptions): Promise<PaginatedResponse<Vault>> {
    const { page, pageSize, state, sort, order } = opts;
    const offset = (page - 1) * pageSize;
    const sortColumn = sort === "total_assets" ? "total_assets" : "created_at";
    const sortDirection = order === "asc" ? "ASC" : "DESC";

    // Build WHERE clause if state filter is provided
    const whereClause = state ? "WHERE v.state = $3" : "";
    const params: any[] = [pageSize, offset];
    if (state) params.push(state);

    // Query vaults with pagination.
    // COALESCE(v.total_assets, '0') guarantees every vault item in the response
    // carries a non-null totalAssets string, satisfying issue #499.
    const vaults = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       ${whereClause}
       ORDER BY v.${sortColumn} ${sortDirection}
       LIMIT $1 OFFSET $2`,
      params,
    );

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM vaults v
       ${state ? "WHERE v.state = $1" : ""}`,
      state ? [state] : [],
    );
    const total = parseInt(countResult[0]?.count ?? "0", 10);

    // Map database rows to Vault type
    const data: Vault[] = vaults.map(mapVaultRow);

    return {
      data,
      total,
      page,
      pageSize,
    };
  }

  async countVaults(): Promise<number> {
    const countResult = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM vaults",
    );
    return parseInt(countResult[0]?.count ?? "0", 10);
  }

  async listVaultsByFactory(factoryId: string): Promise<Vault[]> {
    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       WHERE v.factory_id = $1
       ORDER BY v.created_at DESC`,
      [factoryId],
    );

    return rows.map(mapVaultRow);
  }

  async getVault(contractId: string): Promise<Vault | null> {
    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       WHERE v.contract_id = $1`,
      [contractId],
    );

    if (rows.length === 0) return null;

    return mapVaultRow(rows[0]);
  }

  async getVaultPositions(contractId: string): Promise<UserVaultPosition[]> {
    const rows = await query<{
      id: number;
      user_address: string;
      vault_id: number;
      shares: string;
      deposited: string;
      last_claimed_epoch: number;
      updated_at: Date;
    }>(
      `SELECT uvp.id, uvp.user_address, uvp.vault_id, uvp.shares, 
              uvp.deposited, uvp.last_claimed_epoch, uvp.updated_at
       FROM user_vault_positions uvp
       JOIN vaults v ON uvp.vault_id = v.id
       WHERE v.contract_id = $1
       ORDER BY uvp.shares DESC`,
      [contractId],
    );

    return rows.map((row) => ({
      id: row.id,
      userAddress: row.user_address,
      vaultId: row.vault_id,
      shares: row.shares,
      deposited: row.deposited,
      lastClaimedEpoch: row.last_claimed_epoch,
      updatedAt: row.updated_at,
    }));
  }

  async upsertVault(vault: Partial<Vault> & { contractId: string }): Promise<void> {
    const {
      contractId,
      factoryId = null,
      asset = "",
      name = null,
      symbol = null,
      state = "Funding",
      totalAssets = "0",
      totalSupply = "0",
      fundingTarget = null,
      fundingDeadline = null,
      minDeposit = null,
      maxDepositPerUser = null,
    } = vault;

    logger.info(
      { contractId, factoryId, name, asset },
      "Upserting vault into database",
    );

    await query(
      `INSERT INTO vaults (
         contract_id, factory_id, asset, name, symbol, state,
         total_assets, total_supply,
         funding_target, funding_deadline, min_deposit, max_deposit_per_user,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
       ON CONFLICT (contract_id)
       DO UPDATE SET
         state = EXCLUDED.state,
         total_assets = EXCLUDED.total_assets,
         total_supply = EXCLUDED.total_supply,
         funding_target = COALESCE(EXCLUDED.funding_target, vaults.funding_target),
         funding_deadline = COALESCE(EXCLUDED.funding_deadline, vaults.funding_deadline),
         min_deposit = COALESCE(EXCLUDED.min_deposit, vaults.min_deposit),
         max_deposit_per_user = COALESCE(EXCLUDED.max_deposit_per_user, vaults.max_deposit_per_user),
         updated_at = NOW()`,
      [contractId, factoryId, asset, name, symbol, state, totalAssets, totalSupply,
       fundingTarget, fundingDeadline, minDeposit, maxDepositPerUser],
    );

    logger.info({ contractId }, "Vault upserted successfully");
  }

  /**
   * Compute an early-redemption fee preview for a given share amount.
   *
   * Gross assets are derived from the vault's current exchange rate
   * (total_assets / total_supply). Net assets apply the vault's early
   * redemption fee: netAssets = grossAssets * (10000 - feeBps) / 10000.
   *
   * All monetary values are returned as BigInt-safe strings. Returns `null`
   * if the vault does not exist.
   */
  async getEarlyRedemptionFeePreview(
    contractId: string,
    shares: bigint,
  ): Promise<{
    grossAssets: string;
    feeBps: number;
    feeAmount: string;
    netAssets: string;
  } | null> {
    const rows = await query<{
      total_assets: string | null;
      total_supply: string | null;
      early_redemption_fee_bps: number | null;
    }>(
      `SELECT total_assets, total_supply, early_redemption_fee_bps
       FROM vaults
       WHERE contract_id = $1`,
      [contractId],
    );

    if (rows.length === 0) return null;

    const totalAssets = BigInt(rows[0].total_assets ?? "0");
    const totalSupply = BigInt(rows[0].total_supply ?? "0");
    const feeBps = rows[0].early_redemption_fee_bps ?? 0;

    // Convert shares to underlying assets at the current exchange rate.
    // Fall back to a 1:1 rate when no shares have been minted yet.
    const grossAssets =
      totalSupply > 0n ? (shares * totalAssets) / totalSupply : shares;

    const netAssets = (grossAssets * BigInt(10000 - feeBps)) / 10000n;
    const feeAmount = grossAssets - netAssets;

    return {
      grossAssets: grossAssets.toString(),
      feeBps,
      feeAmount: feeAmount.toString(),
      netAssets: netAssets.toString(),
    };
  }

  /**
   * Collect the data needed for the CSV export of a single vault, including the
   * epoch count. Returns `null` if the vault does not exist.
   */
  async getVaultExportData(contractId: string): Promise<{
    contractId: string;
    state: string;
    totalAssets: string;
    totalSupply: string;
    depositorCount: number;
    epochCount: number;
    expectedApy: number | null;
    maturityDate: Date | null;
  } | null> {
    const rows = await query<{
      contract_id: string;
      state: string;
      total_assets: string | null;
      total_supply: string | null;
      expected_apy: number | null;
      maturity_date: Date | null;
      depositor_count: number;
      epoch_count: number;
    }>(
      `SELECT v.contract_id, v.state, v.total_assets, v.total_supply,
              v.expected_apy, v.maturity_date,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count,
              COALESCE((
                SELECT COUNT(*)::int
                FROM epochs e
                WHERE e.vault_id = v.id
              ), 0) AS epoch_count
       FROM vaults v
       WHERE v.contract_id = $1`,
      [contractId],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      contractId: row.contract_id,
      state: row.state,
      totalAssets: row.total_assets ?? "0",
      totalSupply: row.total_supply ?? "0",
      depositorCount: row.depositor_count,
      epochCount: row.epoch_count,
      expectedApy: row.expected_apy,
      maturityDate: row.maturity_date,
    };
  }

  async getRedemptionQueue(contractId: string): Promise<any[]> {
    const rows = await query<{
      id: number;
      user_address: string;
      shares: string;
      request_time: Date;
    }>(
      `SELECT rr.id, rr.user_address, rr.shares, rr.request_time
       FROM redemption_requests rr
       JOIN vaults v ON rr.vault_id = v.id
       WHERE v.contract_id = $1 AND rr.processed = FALSE
       ORDER BY rr.request_time ASC`,
      [contractId],
    );

    return rows.map((row) => ({
      id: row.id,
      userAddress: row.user_address,
      shares: row.shares,
      requestTime: row.request_time,
    }));
  }
}

