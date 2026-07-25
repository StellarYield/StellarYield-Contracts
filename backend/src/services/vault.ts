import type { Vault, VaultOperator, UserVaultPosition, PaginatedResponse, VaultHolder, VaultHolderSort, OperatorLogEntry } from "../types/index.js";
import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { cacheGet, cacheSet, cacheDel } from "../cache/redis.js";
import { xdr, scValToNative } from "@stellar/stellar-sdk";

const TTL_BY_STATE: Record<string, number> = {
  Active: 10,
  Funding: 30,
  Cancelled: 600,
  Matured: 600,
};
const DEFAULT_TTL = 30;

/**
 * Columns the vault list endpoint may be sorted by (#855).
 *
 * Sort fields are interpolated straight into the ORDER BY clause, so every
 * incoming value must be matched against this allowlist before it reaches SQL.
 */
export const VAULT_SORT_FIELDS = [
  "created_at",
  "updated_at",
  "total_assets",
  "total_supply",
  "state",
  "name",
] as const;

export type VaultSortField = (typeof VAULT_SORT_FIELDS)[number];

export type SortDirection = "asc" | "desc";

export interface VaultSortSpec {
  field: VaultSortField;
  direction: SortDirection;
}

/** Maximum number of comma-separated sort fields accepted by the vault list endpoint (#855). */
export const MAX_VAULT_SORT_FIELDS = 3;

export type VaultSortParseResult =
  | { ok: true; specs: VaultSortSpec[] }
  | { ok: false; message: string };

function isVaultSortField(value: string): value is VaultSortField {
  return (VAULT_SORT_FIELDS as readonly string[]).includes(value);
}

/**
 * Parse the `sort` query parameter into an ordered list of sort specs (#855).
 *
 * Accepts a comma-separated list of `field[:direction]` pairs, e.g.
 * `state:asc,total_assets:desc`. A pair with no explicit direction falls back to
 * `defaultOrder`, which keeps the legacy `?sort=total_assets&order=asc` form
 * working. Returns a failure result rather than throwing, so the route layer can
 * surface the reason as an HTTP 400.
 */
export function parseVaultSort(
  sort: string | undefined,
  defaultOrder: SortDirection = "desc",
): VaultSortParseResult {
  const raw = (sort ?? "").trim();
  if (raw === "") {
    return { ok: true, specs: [{ field: "created_at", direction: defaultOrder }] };
  }

  const segments = raw.split(",").map((segment) => segment.trim());
  if (segments.some((segment) => segment === "")) {
    return { ok: false, message: "sort must not contain empty fields" };
  }
  if (segments.length > MAX_VAULT_SORT_FIELDS) {
    return {
      ok: false,
      message: `sort accepts at most ${MAX_VAULT_SORT_FIELDS} fields, received ${segments.length}`,
    };
  }

  const specs: VaultSortSpec[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    const [field, direction, ...rest] = segment.split(":");
    if (rest.length > 0) {
      return {
        ok: false,
        message: `Invalid sort entry "${segment}", expected "field" or "field:asc|desc"`,
      };
    }
    if (!isVaultSortField(field)) {
      return {
        ok: false,
        message: `Unknown sort field "${field}". Allowed fields: ${VAULT_SORT_FIELDS.join(", ")}`,
      };
    }
    if (direction !== undefined && direction !== "asc" && direction !== "desc") {
      return {
        ok: false,
        message: `Invalid sort direction "${direction}" for field "${field}", expected "asc" or "desc"`,
      };
    }
    if (seen.has(field)) {
      return { ok: false, message: `Duplicate sort field "${field}"` };
    }
    seen.add(field);
    specs.push({ field, direction: direction ?? defaultOrder });
  }

  return { ok: true, specs };
}

interface ListVaultsOptions {
  page: number;
  pageSize: number;
  state?: string;
  category?: string;
  cursor?: string;
  /** Comma-separated `field[:direction]` list — see {@link parseVaultSort} (#855). */
  sort?: string;
  order?: SortDirection;
  /** Inclusive lower bound on `created_at`, as an ISO 8601 date or date-time (#856). */
  createdFrom?: string;
  /** Inclusive upper bound on `created_at`, as an ISO 8601 date or date-time (#856). */
  createdTo?: string;
  /** Inclusive lower bound on `total_assets`, as a non-negative integer string (#857). */
  minTotalAssets?: string;
  /** Inclusive upper bound on `total_assets`, as a non-negative integer string (#857). */
  maxTotalAssets?: string;
  q?: string; // forwarded from controller; listVaults currently delegates text search to /search
}

/** Row-selection filters shared by the vault list query and its COUNT companion. */
interface VaultListFilters {
  state?: string;
  category?: string;
  createdFrom?: string;
  createdTo?: string;
  minTotalAssets?: string;
  maxTotalAssets?: string;
}

/**
 * Build the WHERE fragments common to the vault list query and the COUNT that
 * produces `total`, so both always select the same set of rows.
 *
 * Placeholders are numbered from `startIdx + 1`; `nextIdx` reports the highest
 * placeholder used so the caller can keep numbering from there. Every bound is
 * a bound parameter — nothing here is interpolated from user input.
 */
function buildVaultListFilters(
  filters: VaultListFilters,
  startIdx = 0,
): { conditions: string[]; params: any[]; nextIdx: number } {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = startIdx;

  const add = (toCondition: (placeholder: string) => string, value: unknown): void => {
    idx++;
    conditions.push(toCondition(`$${idx}`));
    params.push(value);
  };

  if (filters.state) add((p) => `v.state = ${p}`, filters.state);
  if (filters.category) add((p) => `v.rwa_category = ${p}`, filters.category);

  // Creation date range (#856). Either bound may be omitted for an open-ended range.
  if (filters.createdFrom) add((p) => `v.created_at >= ${p}::timestamptz`, filters.createdFrom);
  if (filters.createdTo) add((p) => `v.created_at <= ${p}::timestamptz`, filters.createdTo);

  // Total assets (TVL) range (#857). Bound as strings and cast to NUMERIC so
  // values beyond Number.MAX_SAFE_INTEGER keep full precision.
  if (filters.minTotalAssets) add((p) => `v.total_assets >= ${p}::numeric`, filters.minTotalAssets);
  if (filters.maxTotalAssets) add((p) => `v.total_assets <= ${p}::numeric`, filters.maxTotalAssets);

  return { conditions, params, nextIdx: idx };
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
  zkme_verifier_address: string | null;
  rwa_name: string | null;
  rwa_symbol: string | null;
  rwa_document_uri: string | null;
  rwa_category: string | null;
  created_at: Date;
  updated_at: Date;
}

function computeFundingProgress(totalAssets: string, fundingTarget: string | null): number | null {
  if (!fundingTarget) return null;
  const target = parseFloat(fundingTarget);
  if (!target) return 0;
  return Math.min(100, (parseFloat(totalAssets) / target) * 100);
}

function extractAddressFromScVal(topic: unknown): string {
  if (typeof topic === "string") {
    try {
      return String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")));
    } catch {
      return "";
    }
  }
  return "";
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
    zkmeVerifier: row.zkme_verifier_address ?? null,
    rwaName: row.rwa_name,
    rwaSymbol: row.rwa_symbol,
    rwaDocumentUri: row.rwa_document_uri,
    rwaCategory: row.rwa_category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class VaultService {
  /**
   * List non-archived vaults with optional filtering, sorting, and pagination.
   * Results are cached (TTL depends on `state`, see `TTL_BY_STATE`) keyed by
   * the full options object.
   *
   * Supports two mutually-driven pagination modes: page/offset (default) and
   * cursor-based (when `opts.cursor` is set, `total` is not computed — cursor
   * pagination is meant for cheap infinite-scroll, not page counts).
   *
   * @param opts.page - 1-indexed page number, used when `cursor` is not set.
   * @param opts.pageSize - Number of vaults per page/batch.
   * @param opts.state - Optional exact-match filter on vault state (e.g. "Active").
   * @param opts.category - Optional exact-match filter on `rwa_category`.
   * @param opts.cursor - Optional base64url-encoded `{ id, created_at }` cursor from a
   *   previous response's `nextCursor`. When present, switches to cursor-based pagination.
   * @param opts.sort - Column to sort by: "created_at" or "total_assets".
   * @param opts.order - Sort direction: "asc" or "desc".
   * @param opts.q - Forwarded from the controller but unused here; text search is
   *   handled by `searchVaults` instead.
   * @returns A page of vaults plus `total` (0 when cursor-paginated), `page`,
   *   `pageSize`, and `nextCursor` (null when there is no further page).
   */
  async listVaults(opts: ListVaultsOptions): Promise<PaginatedResponse<Vault>> {
    const cacheKey = `vaults:list:${JSON.stringify(opts)}`;
    const cached = await cacheGet<PaginatedResponse<Vault>>(cacheKey);
    if (cached) return cached;

    const { page, pageSize, state, category, cursor, order } = opts;

    // Multi-field sorting (#855). The route layer validates `sort` and returns a
    // 400 for bad input; re-parsing here keeps unvalidated callers out of SQL.
    const sortResult = parseVaultSort(opts.sort, order ?? "desc");
    if (!sortResult.ok) {
      throw new Error(`Invalid sort parameter: ${sortResult.message}`);
    }
    const orderByClause = sortResult.specs
      .map((spec) => `v.${spec.field} ${spec.direction === "asc" ? "ASC" : "DESC"}`)
      .join(", ");

    // Cursor pagination keys off (created_at, id), so the tiebreaker and the
    // cursor comparison both follow the primary sort field's direction.
    const sortDirection = sortResult.specs[0].direction === "asc" ? "ASC" : "DESC";
    const isDesc = sortDirection === "DESC";

    // Decode cursor if provided
    let cursorId: number | null = null;
    let cursorCreatedAt: Date | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        cursorId = typeof decoded.id === "number" ? decoded.id : null;
        cursorCreatedAt = decoded.created_at ? new Date(decoded.created_at) : null;
      } catch {
        cursorId = null;
        cursorCreatedAt = null;
      }
    }

    const filters: VaultListFilters = {
      state,
      category,
      createdFrom: opts.createdFrom,
      createdTo: opts.createdTo,
      minTotalAssets: opts.minTotalAssets,
      maxTotalAssets: opts.maxTotalAssets,
    };
    const filtered = buildVaultListFilters(filters);
    const conditions = filtered.conditions;
    const params = filtered.params;
    let paramIdx = filtered.nextIdx;

    // Filter out archived vaults from standard list queries (#674)
    conditions.push(`v.archived = FALSE`);

    if (cursorId !== null && cursorCreatedAt !== null) {
      paramIdx++;
      const cursorTs = cursorCreatedAt.toISOString();
      if (isDesc) {
        conditions.push(
          `(v.created_at, v.id) < ($${paramIdx}::timestamptz, $${paramIdx + 1})`,
        );
      } else {
        conditions.push(
          `(v.created_at, v.id) > ($${paramIdx}::timestamptz, $${paramIdx + 1})`,
        );
      }
      params.push(cursorTs, cursorId);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch one extra row to determine if there's a next page
    const limit = cursor ? pageSize + 1 : pageSize;
    const limitIdx = paramIdx + 1;
    params.push(limit);

    let sql: string;
    if (cursor) {
      sql = `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
               v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
               v.created_at, v.updated_at,
               v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
               v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
               COALESCE((
                 SELECT COUNT(*)::int
                 FROM user_vault_positions uvp
                 WHERE uvp.vault_id = v.id AND uvp.shares > 0
               ), 0) AS depositor_count
        FROM vaults v
        ${whereClause}
        ORDER BY ${orderByClause}, v.id ${sortDirection}
        LIMIT $${limitIdx}`;
    } else {
      const offset = (page - 1) * pageSize;
      params.push(offset);
      sql = `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
               v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
               v.created_at, v.updated_at,
               v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
               v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
               COALESCE((
                 SELECT COUNT(*)::int
                 FROM user_vault_positions uvp
                 WHERE uvp.vault_id = v.id AND uvp.shares > 0
               ), 0) AS depositor_count
        FROM vaults v
        ${whereClause}
        ORDER BY ${orderByClause}
        LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`;
    }

    const vaults = await query<VaultRow>(sql, params);

    // Determine nextCursor if cursor-based pagination
    let nextCursor: string | null = null;
    if (cursor && vaults.length > pageSize) {
      vaults.pop(); // remove the extra row
      const last = vaults[vaults.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ id: last.id, created_at: last.created_at.toISOString() }),
      ).toString("base64url");
    } else if (cursor) {
      nextCursor = null;
    }

    // Get total count (only when not using cursor, to avoid expensive counts)
    let total = 0;
    if (!cursor) {
      const { conditions: countConditions, params: countParams } =
        buildVaultListFilters(filters);
      const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(" AND ")}` : "";
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM vaults v ${countWhere}`,
        countParams,
      );
      total = parseInt(countResult[0]?.count ?? "0", 10);
    }

    // Map database rows to Vault type
    const data: Vault[] = vaults.map(mapVaultRow);

    const result: PaginatedResponse<Vault> = { data, total, page, pageSize, nextCursor };
    const listTtl = TTL_BY_STATE[state ?? ""] ?? DEFAULT_TTL;
    await cacheSet(cacheKey, result, listTtl);
    return result;
  }

  /**
   * Count non-archived vaults.
   *
   * @returns The total number of vaults where `archived = FALSE`.
   */
  async countVaults(): Promise<number> {
    const countResult = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM vaults WHERE archived = FALSE",
    );
    return parseInt(countResult[0]?.count ?? "0", 10);
  }

  /**
   * List archived vaults ordered by most recently archived first.
   * Used by the admin endpoint GET /api/v1/admin/vaults/archived (#675).
   */
  async listArchivedVaults(): Promise<Vault[]> {
    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       WHERE v.archived = TRUE
       ORDER BY v.updated_at DESC`,
      [],
    );

    return rows.map(mapVaultRow);
  }

  async listCategories(): Promise<string[]> {
    const rows = await query<{ rwa_category: string | null }>(
      "SELECT DISTINCT rwa_category FROM vaults WHERE rwa_category IS NOT NULL AND archived = FALSE ORDER BY rwa_category ASC",
    );
    return rows.map((r) => r.rwa_category!);
  }

  async listVaultsByFactory(factoryId: string): Promise<Vault[]> {
    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.zkme_verifier_address,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       WHERE v.factory_id = $1 AND v.archived = FALSE
       ORDER BY v.created_at DESC`,
      [factoryId],
    );

    return rows.map(mapVaultRow);
  }

  /**
   * Fetch a single vault by its on-chain contract address, including a live
   * depositor count. Results are cached under `vault:{contractId}` with a
   * TTL that depends on the vault's state (see `TTL_BY_STATE`).
   *
   * @param contractId - The vault's Stellar contract address (e.g. `CBQHN...`).
   * @returns The matching `Vault`, or `null` if no vault exists with that
   *   `contractId` (archived vaults are still returned — this method does not
   *   filter on `archived`).
   */
  async getVault(contractId: string): Promise<Vault | null> {
    const cacheKey = `vault:${contractId}`;
    const cached = await cacheGet<Vault>(cacheKey);
    if (cached) return cached;

    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.zkme_verifier_address,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
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

    const vault = mapVaultRow(rows[0]);
    const ttl = TTL_BY_STATE[vault.state] ?? DEFAULT_TTL;
    await cacheSet(cacheKey, vault, ttl);
    return vault;
  }

  /**
   * List every user's share position in a vault, most shares first.
   * Unlike `listVaultHolders`, this is not paginated and includes positions
   * with zero shares (e.g. users who have fully withdrawn).
   *
   * @param contractId - The vault's Stellar contract address.
   * @returns All `UserVaultPosition` rows for the vault, sorted by `shares`
   *   descending. Returns an empty array if the vault does not exist or has
   *   no recorded positions.
   */
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

  /**
   * Insert a new vault or update an existing one (matched by `contractId`),
   * then invalidate its cache entries. Called by the indexer when it observes
   * `vault_created` (insert) or a subsequent state/asset-changing event
   * (partial update).
   *
   * On conflict, `state`, `totalAssets`, and `totalSupply` are always
   * overwritten with the given values, while the RWA/funding metadata fields
   * (`fundingTarget`, `fundingDeadline`, `minDeposit`, `maxDepositPerUser`,
   * `rwaName`, `rwaSymbol`, `rwaDocumentUri`, `rwaCategory`) are only
   * overwritten when the incoming value is non-null — passing a partial
   * update will not clear previously stored metadata for fields you omit.
   * Any field not listed above (e.g. `name`, `symbol`, `asset`, `factoryId`)
   * is only ever set on insert and defaults as noted below.
   *
   * @param vault.contractId - Required. The vault's Stellar contract address;
   *   the conflict key for the upsert.
   * @param vault.factoryId - Defaults to `null` on insert.
   * @param vault.asset - Defaults to `""` on insert.
   * @param vault.name - Defaults to `null` on insert.
   * @param vault.symbol - Defaults to `null` on insert.
   * @param vault.state - Vault lifecycle state; defaults to `"Funding"` on
   *   insert and is always overwritten on update.
   * @param vault.totalAssets - Defaults to `"0"` on insert and is always
   *   overwritten on update.
   * @param vault.totalSupply - Defaults to `"0"` on insert and is always
   *   overwritten on update.
   * @param vault.fundingTarget - Only applied if non-null; existing value is
   *   preserved otherwise.
   * @param vault.fundingDeadline - Only applied if non-null; existing value
   *   is preserved otherwise.
   * @param vault.minDeposit - Only applied if non-null; existing value is
   *   preserved otherwise.
   * @param vault.maxDepositPerUser - Only applied if non-null; existing value
   *   is preserved otherwise.
   * @param vault.rwaName - Only applied if non-null; existing value is
   *   preserved otherwise.
   * @param vault.rwaSymbol - Only applied if non-null; existing value is
   *   preserved otherwise.
   * @param vault.rwaDocumentUri - Only applied if non-null; existing value is
   *   preserved otherwise.
   * @param vault.rwaCategory - Only applied if non-null; existing value is
   *   preserved otherwise.
   * @returns Resolves once the row is written and the `vault:{contractId}`
   *   and `vaults:list:*` cache entries have been invalidated.
   */
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
      rwaCategory = null,
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
         rwa_name, rwa_symbol, rwa_document_uri, rwa_category,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
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
         rwa_category = COALESCE(EXCLUDED.rwa_category, vaults.rwa_category),
         updated_at = NOW()`,
      [contractId, factoryId, asset, name, symbol, state, totalAssets, totalSupply,
       fundingTarget, fundingDeadline, minDeposit, maxDepositPerUser,
       rwaName, rwaSymbol, rwaDocumentUri, rwaCategory],
    );

    logger.info({ contractId }, "Vault upserted successfully");
    await cacheDel(`vault:${contractId}`);
    await cacheDel("vaults:list:*");
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

  async getVaultOperators(contractId: string): Promise<VaultOperator[]> {
    const rows = await query<{
      address: string;
      active: boolean;
      assigned_at: Date;
    }>(
      `SELECT vo.address, vo.active, vo.assigned_at
       FROM vault_operators vo
       JOIN vaults v ON vo.vault_id = v.id
       WHERE v.contract_id = $1
       ORDER BY vo.assigned_at ASC`,
      [contractId],
    );

    return rows.map((row) => ({
      address: row.address,
      active: row.active,
      assignedAt: row.assigned_at.toISOString(),
    }));
  }

  async getOperatorLog(
    contractId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResponse<OperatorLogEntry>> {
    const offset = (page - 1) * pageSize;

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM indexed_events
       WHERE contract_id = $1 AND event_type IN ('op_add', 'op_rem')`,
      [contractId],
    );
    const total = parseInt(countResult[0]?.count ?? "0", 10);

    const rows = await query<{
      ledger: number;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT ledger, event_type, payload, created_at
       FROM indexed_events
       WHERE contract_id = $1 AND event_type IN ('op_add', 'op_rem')
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [contractId, pageSize, offset],
    );

    const data: OperatorLogEntry[] = rows.map((row) => {
      const payload = row.payload;
      const topics = (payload["topic"] ?? payload["topics"]) as unknown[] | undefined;
      const callerAddress = Array.isArray(topics) && topics.length >= 2
        ? extractAddressFromScVal(topics[1])
        : "";
      const operatorAddress = Array.isArray(topics) && topics.length >= 3
        ? extractAddressFromScVal(topics[2])
        : "";

      let timestamp: string;
      const ledgerClosedAt = payload["ledgerClosedAt"];
      if (typeof ledgerClosedAt === "string") {
        timestamp = ledgerClosedAt;
      } else {
        timestamp = row.created_at.toISOString();
      }

      return {
        operatorAddress,
        action: row.event_type === "op_add" ? "added" : "removed",
        callerAddress,
        ledger: row.ledger,
        timestamp,
      };
    });

    return { data, total, page, pageSize };
  }

  // ── Issue #640 / #646: Combined search with optional fuzzy matching ──────────
  async searchVaults(opts: {
    q?: string;
    category?: string;
    state?: string;
    page: number;
    pageSize: number;
    sort: string;
    order: string;
    fuzzy?: boolean;
  }): Promise<PaginatedResponse<Vault>> {
    const { q, category, state, page, pageSize, sort, order, fuzzy } = opts;
    const offset = (page - 1) * pageSize;
    const sortColumn = sort === "total_assets" ? "total_assets" : "created_at";
    const sortDirection = order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = [];
    const params: any[] = [];

    if (state) {
      conditions.push(`v.state = $${params.length + 1}`);
      params.push(state);
    }
    if (q) {
      if (fuzzy) {
        conditions.push(`similarity(v.name, $${params.length + 1}) > 0.3`);
        params.push(q);
      } else {
        conditions.push(`(v.name ILIKE $${params.length + 1} OR v.symbol ILIKE $${params.length + 1} OR v.rwa_name ILIKE $${params.length + 1})`);
        params.push(`%${q}%`);
      }
    }
    if (category) {
      conditions.push(`v.rwa_category = $${params.length + 1}`);
      params.push(category);
    }

    // Filter out archived vaults (#674)
    conditions.push(`v.archived = FALSE`);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const vaults = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       ${whereClause}
       ORDER BY v.${sortColumn} ${sortDirection}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM vaults v
       ${whereClause}`,
      params,
    );
    const total = parseInt(countResult[0]?.count ?? "0", 10);

    return {
      data: vaults.map(mapVaultRow),
      total,
      page,
      pageSize,
    };
  }

  // ── Issue #641: Name availability check ───────────────────────────────────────
  async checkVaultName(name: string): Promise<boolean> {
    const rows = await query<{ id: number }>(
      "SELECT id FROM vaults WHERE LOWER(name) = LOWER($1) LIMIT 1",
      [name],
    );
    return rows.length === 0;
  }

  // ── Issue #642: Trending vaults ─────────────────────────────────────────────
  async getTrendingVaults(): Promise<{
    contractId: string;
    name: string | null;
    recentDepositVolume: string;
  }[]> {
    const rows = await query<{
      contract_id: string;
      name: string | null;
      total_deposited: string;
    }>(
      `SELECT v.contract_id, v.name,
              COALESCE(SUM(
                CASE
                  WHEN ie.payload #>> '{value,vec,0,i128,lo}' IS NOT NULL
                  THEN (ie.payload #>> '{value,vec,0,i128,lo}')::numeric
                  ELSE 0
                END
              ), 0)::text AS total_deposited
       FROM indexed_events ie
       JOIN vaults v ON ie.contract_id = v.contract_id
       WHERE ie.event_type = 'deposit'
         AND ie.created_at > NOW() - INTERVAL '24 hours'
         AND v.archived = FALSE
       GROUP BY v.contract_id, v.name
       ORDER BY total_deposited DESC
       LIMIT 10`,
    );

    return rows.map((r) => ({
      contractId: r.contract_id,
      name: r.name,
      recentDepositVolume: r.total_deposited,
    }));
  }

  // ── Issue #643: New vaults ──────────────────────────────────────────────────
  async getNewVaults(days: number): Promise<Vault[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       WHERE v.created_at > $1 AND v.archived = FALSE
       ORDER BY v.created_at DESC`,
      [cutoff],
    );

    return rows.map(mapVaultRow);
  }

  // ── Issue #644: Maturing-soon vaults ────────────────────────────────────────
  async getMaturitySoonVaults(days: number): Promise<Array<Vault & { daysUntilMaturity: number }>> {
    const rows = await query<VaultRow & { days_until_maturity: number }>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count,
              GREATEST(0, (v.maturity_date::date - CURRENT_DATE)) AS days_until_maturity
       FROM vaults v
       WHERE v.state = 'Active'
         AND v.maturity_date > NOW()
         AND v.maturity_date <= NOW() + ($1::int * INTERVAL '1 day')
         AND v.archived = FALSE
       ORDER BY v.maturity_date ASC`,
      [days],
    );

    return rows.map((row) => ({
      ...mapVaultRow(row),
      daysUntilMaturity: row.days_until_maturity,
    }));
  }

  // ── Issue #645: Fully-funded vaults ─────────────────────────────────────────
  async getFullyFundedVaults(): Promise<Vault[]> {
    const rows = await query<VaultRow>(
      `SELECT v.id, v.contract_id, v.factory_id, v.asset, v.name, v.symbol, v.state,
              v.total_assets, v.total_supply, v.total_shares_ever_minted, v.total_shares_ever_burned,
              v.created_at, v.updated_at,
              v.funding_target, v.funding_deadline, v.min_deposit, v.max_deposit_per_user,
              v.rwa_name, v.rwa_symbol, v.rwa_document_uri, v.rwa_category,
              COALESCE((
                SELECT COUNT(*)::int
                FROM user_vault_positions uvp
                WHERE uvp.vault_id = v.id AND uvp.shares > 0
              ), 0) AS depositor_count
       FROM vaults v
       WHERE v.state = 'Funding'
         AND v.funding_target IS NOT NULL
         AND v.funding_target::numeric > 0
         AND v.total_assets::numeric >= v.funding_target::numeric
         AND v.archived = FALSE
       ORDER BY (v.total_assets::numeric / v.funding_target::numeric) DESC`,
    );

    return rows.map(mapVaultRow);
  }

  // ── Issue #647: Similar vaults ───────────────────────────────────────────────
  async getSimilarVaults(contractId: string): Promise<{
    contractId: string;
    name: string | null;
    totalAssets: string;
    rwaCategory: string | null;
  }[] | null> {
    const targetRows = await query<{
      rwa_category: string | null;
      total_assets: string;
    }>(
      "SELECT rwa_category, total_assets FROM vaults WHERE contract_id = $1",
      [contractId],
    );

    if (targetRows.length === 0) return null;

    const { rwa_category, total_assets } = targetRows[0];

    if (!rwa_category) return [];

    const rows = await query<{
      contract_id: string;
      name: string | null;
      total_assets: string;
      rwa_category: string | null;
    }>(
      `SELECT contract_id, name, total_assets, rwa_category
       FROM vaults
       WHERE rwa_category = $1
         AND state = 'Active'
         AND contract_id != $2
         AND archived = FALSE
       ORDER BY ABS(total_assets::numeric - $3::numeric) ASC
       LIMIT 5`,
      [rwa_category, contractId, total_assets],
    );

    return rows.map((r) => ({
      contractId: r.contract_id,
      name: r.name,
      totalAssets: r.total_assets ?? "0",
      rwaCategory: r.rwa_category,
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
