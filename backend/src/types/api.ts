/**
 * Public API request and response types (Issue #868).
 *
 * These mirror `api/openapi.json` exactly and exist so TypeScript consumers
 * can depend on the response shapes without pulling in the backend runtime.
 * This module is types-only: it contains no runtime imports and no emitted
 * JavaScript, so importing it can never drag server code into a client bundle.
 *
 * The shapes are asserted against the generated spec types in
 * `api-types.test.ts`, so a spec change that is not mirrored here fails the
 * build rather than silently drifting.
 */

/** Lifecycle state of a vault, as reported by the API. */
export type ApiVaultState = "Funding" | "Active" | "Matured" | "Closed" | "Cancelled";

/** A vault as returned by `GET /api/v1/vaults` and `GET /api/v1/vaults/{contractId}`. */
export interface ApiVault {
  id: number;
  contractId: string;
  factoryId: string | null;
  asset: string;
  name: string | null;
  symbol: string | null;
  state: ApiVaultState;
  /** Token amounts are strings: they exceed `Number.MAX_SAFE_INTEGER`. */
  totalAssets: string;
  totalSupply: string;
  depositorCount: number;
  fundingTarget: string | null;
  /** ISO-8601 timestamp, or `null` when the vault is not funding. */
  fundingDeadline: string | null;
  fundingProgress: number | null;
  rwaCategory: string | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  lastIndexedLedger: number | null;
  lastIndexedAt: string | null;
  decimalsMismatch: boolean;
}

/**
 * Alias kept for the name used in the issue's acceptance criteria, so
 * `import type { Vault } from '@stellaryield/backend/types'` resolves.
 */
export type { ApiVault as Vault };

/** One bucket of the TVL time series returned by the tvl-history endpoint. */
export interface ApiTvlBucket {
  /** ISO-8601 timestamp for the start of the bucket. */
  bucket: string;
  avgTotalAssets: string;
  maxTotalAssets: string;
  minTotalAssets: string;
}

/** One group in the vault group-by aggregation. */
export interface ApiVaultGroupBy {
  group: string;
  vaultCount: number;
  totalValueLocked: string;
  averageApy: number | null;
}

/** Error body returned for 4xx and 5xx responses. */
export interface ApiError {
  error: string;
  message: string;
}

/** Response body of `GET /api/v1/health` and `GET /health`. */
export interface ApiHealth {
  version: string;
  status: string;
}

/** Response body of `GET /api/v1/analytics/summary`. */
export interface ApiAnalyticsSummary {
  totalUsers: number;
  totalVaults: number;
  totalValueLocked: string;
  totalYieldDistributed: string;
  totalDepositors: number;
}

/** Response body of `GET /api/v1/analytics/tvl`. */
export interface ApiTvlAggregate {
  totalValueLocked: string;
  activeVaultCount: number;
  fundingVaultCount: number;
}

/** Query parameters accepted by `GET /api/v1/vaults`. */
export interface ListVaultsQuery {
  page?: number;
  pageSize?: number;
  state?: ApiVaultState;
}

/** Response body of `GET /api/v1/vaults`. */
export interface ListVaultsResponse {
  data: ApiVault[];
  total: number;
  page: number;
  pageSize: number;
}

/** Granularity accepted by the tvl-history `bucket` parameter. */
export type TvlBucketSize = "hour" | "day" | "week";

/** Query parameters accepted by `GET /api/v1/vaults/{contractId}/tvl-history`. */
export interface TvlHistoryQuery {
  /** ISO-8601 timestamp; defaults to the start of the retention window. */
  from?: string;
  /** ISO-8601 timestamp; defaults to now. */
  to?: string;
  bucket?: TvlBucketSize;
}

/** Field the group-by endpoint aggregates on. */
export type VaultGroupByField = "state" | "rwaCategory" | "asset";

/** Query parameters accepted by `GET /api/v1/analytics/vaults/group-by`. */
export interface VaultGroupByQuery {
  by: VaultGroupByField;
}
