import type {
  Vault,
  UserVaultPosition,
  PaginatedResponse,
  VaultHolder,
  VaultHolderSort,
} from "../types/index.js";
import { query } from "../db/index.js";
import { logger } from "../logger.js";

interface ListVaultsOptions {
  page: number;
  pageSize: number;
  state?: string;
  sort: "created_at" | "total_assets";
  order: "asc" | "desc";
  q?: string;
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
  rwa_name: string | null;
  rwa_symbol: string | null;
  rwa_document_uri: string | null;
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
    rwaName: row.rwa_name,
    rwaSymbol: row.rwa_symbol,
    rwaDocumentUri: row.rwa_document_uri,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class VaultService {
  async listVaults(opts: ListVaultsOptions): Promise<PaginatedResponse<Vault>> {
    const { page, pageSize, state, sort, order, q } = opts;
    const offset = (page - 1) * pageSize;
    const sortColumn = sort === "total_assets" ? "total_assets" : "created_at";
    const sortDirection = order === "asc" ? "ASC" : "DESC";

    // Build WHERE conditions
    const whereConditions: string[] = [];
    const params: any[] = [pageSize, offset];
    let paramIndex = 3;

    if (state) {
      whereConditions.push(`v.state = $${paramIndex}`);
      params.push(state);
      paramIndex++;
    }

    if (q && q.trim()) {
      whereConditions.push(`v.search_vector @@ plainto_tsquery('english', $${paramIndex})`);
      params.push(q.trim());
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

    // When searching, rank by relevance; otherwise use standard sort
    let orderByClause: string;
    if (q && q.trim()) {
      orderByClause = `ORDER BY ts_rank(v.search_vector, plainto_tsquery('english', $${paramIndex})) DESC, v.${sortColumn} ${sortDirection}`;
      params.push(q.trim());
    } else {
      orderByClause = `ORDER BY v.${sortColumn} ${sortDirection}`;
    }

    // Query vaults with pagination.
    // COALESCE(v.total_assets, '0') guarantees every vault item in the response
    // carries a non-null totalAssets string, satisfying issue #499.
    const vaults = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       ${whereClause}
       ${orderByClause}
       LIMIT $1 OFFSET $2`,
      params,
    );

    // Build count query with same WHERE clause
    const countParams: any[] = [];
    let countParamIndex = 1;
    const countWhereConditions: string[] = [];

    if (state) {
      countWhereConditions.push(`v.state = $${countParamIndex}`);
      countParams.push(state);
      countParamIndex++;
    }

    if (q && q.trim()) {
      countWhereConditions.push(`v.search_vector @@ plainto_tsquery('english', $${countParamIndex})`);
      countParams.push(q.trim());
      countParamIndex++;
    }

    const countWhereClause = countWhereConditions.length > 0 ? `WHERE ${countWhereConditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM vaults v
       ${countWhereClause}`,
      countParams,
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
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri,
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
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri,
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

  async listVaultHolders(
    contractId: string,
    opts: { page: number; pageSize: number; sort: VaultHolderSort },
  ): Promise<PaginatedResponse<VaultHolder> | null> {
    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) return null;

    const vaultId = vaultRows[0].id;
    const pageSize = Math.min(Math.max(opts.pageSize, 1), 100);
    const page = Math.max(opts.page, 1);
    const offset = (page - 1) * pageSize;
    const sortColumn = opts.sort === "deposited" ? "deposited" : "shares";

    const rows = await query<{
      user_address: string;
      shares: string;
      deposited: string;
      updated_at: Date;
    }>(
      `SELECT user_address, shares, deposited, updated_at
       FROM user_vault_positions
       WHERE vault_id = $1 AND shares > 0
       ORDER BY ${sortColumn} DESC, user_address ASC
       LIMIT $2 OFFSET $3`,
      [vaultId, pageSize, offset],
    );

    const countRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM user_vault_positions
       WHERE vault_id = $1 AND shares > 0`,
      [vaultId],
    );

    return {
      data: rows.map((row) => ({
        userAddress: row.user_address,
        shares: row.shares,
        deposited: row.deposited,
        lastUpdatedAt: row.updated_at,
      })),
      total: parseInt(countRows[0]?.count ?? "0", 10),
      page,
      pageSize,
    };
  }

  async countVaultHolders(contractId: string): Promise<number | null> {
    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) return null;

    const rows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM user_vault_positions
       WHERE vault_id = $1 AND shares > 0`,
      [vaultRows[0].id],
    );

    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async getVaultHoldersForExport(contractId: string): Promise<VaultHolder[] | null> {
    const vaultRows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE contract_id = $1",
      [contractId],
    );
    if (vaultRows.length === 0) return null;

    const rows = await query<{
      user_address: string;
      shares: string;
      deposited: string;
      updated_at: Date;
    }>(
      `SELECT user_address, shares, deposited, updated_at
       FROM user_vault_positions
       WHERE vault_id = $1 AND shares > 0
       ORDER BY shares DESC, user_address ASC`,
      [vaultRows[0].id],
    );

    return rows.map((row) => ({
      userAddress: row.user_address,
      shares: row.shares,
      deposited: row.deposited,
      lastUpdatedAt: row.updated_at,
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
      rwaName = null,
      rwaSymbol = null,
      rwaDocumentUri = null,
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
         rwa_name, rwa_symbol, rwa_document_uri,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
       ON CONFLICT (contract_id)
       DO UPDATE SET
         state = EXCLUDED.state,
         total_assets = EXCLUDED.total_assets,
         total_supply = EXCLUDED.total_supply,
         funding_target = COALESCE(EXCLUDED.funding_target, vaults.funding_target),
         funding_deadline = COALESCE(EXCLUDED.funding_deadline, vaults.funding_deadline),
         min_deposit = COALESCE(EXCLUDED.min_deposit, vaults.min_deposit),
         max_deposit_per_user = COALESCE(EXCLUDED.max_deposit_per_user, vaults.max_deposit_per_user),
         rwa_name = COALESCE(EXCLUDED.rwa_name, vaults.rwa_name),
         rwa_symbol = COALESCE(EXCLUDED.rwa_symbol, vaults.rwa_symbol),
         rwa_document_uri = COALESCE(EXCLUDED.rwa_document_uri, vaults.rwa_document_uri),
         updated_at = NOW()`,
      [contractId, factoryId, asset, name, symbol, state, totalAssets, totalSupply,
       fundingTarget, fundingDeadline, minDeposit, maxDepositPerUser,
       rwaName, rwaSymbol, rwaDocumentUri],
    );

    logger.info({ contractId }, "Vault upserted successfully");
  }

  async listVaultOperators(contractId: string): Promise<{
    operator: string;
    addedBy: string;
    addedAt: Date;
    removedAt: Date | null;
    removedBy: string | null;
  }[]> {
    const rows = await query<{
      operator: string;
      added_by: string;
      added_at: Date;
      removed_at: Date | null;
      removed_by: string | null;
    }>(
      `SELECT vo.operator, vo.added_by, vo.added_at, vo.removed_at, vo.removed_by
       FROM vault_operators vo
       JOIN vaults v ON vo.vault_id = v.id
       WHERE v.contract_id = $1 AND vo.removed_at IS NULL
       ORDER BY vo.added_at DESC`,
      [contractId],
    );
    return rows.map((r) => ({
      operator: r.operator,
      addedBy: r.added_by,
      addedAt: r.added_at,
      removedAt: r.removed_at,
      removedBy: r.removed_by,
    }));
  }

  async listVaultRoles(contractId: string): Promise<{
    userAddress: string;
    role: string;
    grantedAt: Date;
    revokedAt: Date | null;
  }[]> {
    const rows = await query<{
      user_address: string;
      role: string;
      granted_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT vr.user_address, vr.role, vr.granted_at, vr.revoked_at
       FROM vault_roles vr
       JOIN vaults v ON vr.vault_id = v.id
       WHERE v.contract_id = $1 AND vr.revoked_at IS NULL
       ORDER BY vr.granted_at DESC`,
      [contractId],
    );
    return rows.map((r) => ({
      userAddress: r.user_address,
      role: r.role,
      grantedAt: r.granted_at,
      revokedAt: r.revoked_at,
    }));
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

  async getCompoundProjection(
    contractId: string,
    shares: string,
    epochs: number,
  ): Promise<{ projectedValue: string; compoundedYield: string; epochsProjected: number } | null> {
    const epochRows = await query<{
      id: number;
      yield_amount: string;
      total_shares: string;
    }>(
      `SELECT e.id, e.yield_amount, e.total_shares
       FROM epochs e
       JOIN vaults v ON e.vault_id = v.id
       WHERE v.contract_id = $1
       ORDER BY e.epoch ASC`,
      [contractId],
    );

    if (epochRows.length === 0) {
      return null;
    }

    let sumYieldPerShare = BigInt(0);
    const DECIMALS = BigInt(10) ** BigInt(18);

    for (const row of epochRows) {
      const yieldBig = BigInt(row.yield_amount);
      const sharesBig = BigInt(row.total_shares);
      if (sharesBig > BigInt(0)) {
        const yieldPerShare = (yieldBig * DECIMALS) / sharesBig;
        sumYieldPerShare += yieldPerShare;
      }
    }

    const avgYieldPerShare = sumYieldPerShare / BigInt(epochRows.length);
    const principal = BigInt(shares);

    let projectedValue = principal;
    for (let i = 0; i < epochs; i++) {
      projectedValue = (projectedValue * (DECIMALS + avgYieldPerShare)) / DECIMALS;
    }

    const compoundedYield = projectedValue - principal;

    const projectedStr = projectedValue.toString();
    const projectedPadded = projectedStr.padStart(19, "0");
    const projectedInt = projectedPadded.slice(0, -18);
    const projectedFrac = projectedPadded.slice(-18);
    const projectedFormatted = `${projectedInt}.${projectedFrac}`;

    const yieldStr = compoundedYield.toString();
    const yieldPadded = yieldStr.padStart(19, "0");
    const yieldInt = yieldPadded.slice(0, -18);
    const yieldFrac = yieldPadded.slice(-18);
    const yieldFormatted = `${yieldInt}.${yieldFrac}`;

    return {
      projectedValue: projectedFormatted,
      compoundedYield: yieldFormatted,
      epochsProjected: epochs,
    };
  }
}
