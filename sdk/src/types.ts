/**
 * TypeScript mirrors of Soroban `contracttype` structs and enums in the Rust contracts.
 * Field names and types align with `single_rwa_vault::types` and `vault_factory::types`.
 */

/** `single_rwa_vault::VaultState` */
export type VaultState =
  | "Funding"
  | "Active"
  | "Matured"
  | "Closed"
  | "Cancelled";

/** `vault_factory::VaultType` */
export type VaultType = "SingleRwa" | "Aggregator";

/** `single_rwa_vault::InitParams` */
export interface InitParams {
  asset: string;
  share_name: string;
  share_symbol: string;
  share_decimals: number;
  admin: string;
  zkme_verifier: string;
  cooperator: string;
  funding_target: bigint;
  maturity_date: bigint;
  min_deposit: bigint;
  max_deposit_per_user: bigint;
  early_redemption_fee_bps: number;
  funding_deadline: bigint;
  rwa_name: string;
  rwa_symbol: string;
  rwa_document_uri: string;
  rwa_category: string;
  expected_apy: number;
}

/** `single_rwa_vault::RwaDetails` */
export interface RwaDetails {
  name: string;
  symbol: string;
  document_uri: string;
  category: string;
  expected_apy: number;
}

/** `single_rwa_vault::RedemptionRequest` */
export interface RedemptionRequest {
  user: string;
  shares: bigint;
  request_time: bigint;
  processed: boolean;
}

/** `vault_factory::VaultInfo` */
export interface VaultInfo {
  vault: string;
  asset: string;
  vault_type: VaultType;
  name: string;
  symbol: string;
  active: boolean;
  created_at: bigint;
}

/** `vault_factory::BatchVaultParams` / `CreateVaultParams` */
export interface BatchVaultParams {
  asset: string;
  name: string;
  symbol: string;
  rwa_name: string;
  rwa_symbol: string;
  rwa_document_uri: string;
  rwa_category: string;
  expected_apy: number;
  maturity_date: bigint;
  funding_deadline: bigint;
  funding_target: bigint;
  min_deposit: bigint;
  max_deposit_per_user: bigint;
  early_redemption_fee_bps: number;
}

export type CreateVaultParams = BatchVaultParams;

/** `vault_factory::SingleRwaVaultInitParams` (deploy constructor payload) */
export interface SingleRwaVaultInitParams {
  asset: string;
  share_name: string;
  share_symbol: string;
  share_decimals: number;
  admin: string;
  zkme_verifier: string;
  cooperator: string;
  funding_target: bigint;
  maturity_date: bigint;
  min_deposit: bigint;
  max_deposit_per_user: bigint;
  early_redemption_fee_bps: number;
  funding_deadline: bigint;
  rwa_name: string;
  rwa_symbol: string;
  rwa_document_uri: string;
  rwa_category: string;
  expected_apy: number;
}
