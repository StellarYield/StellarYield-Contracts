//! Shared types for VaultFactory.

use soroban_sdk::{contracttype, Address, String};

/// Vault type — mirrors the Solidity VaultType enum.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum VaultType {
    SingleRwa,
    Aggregator,
}

/// Vault registration metadata.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VaultInfo {
    pub vault: Address,
    pub asset: Address,
    pub vault_type: VaultType,
    pub name: String,
    pub symbol: String,
    pub active: bool,
    pub created_at: u64,
}

/// Initialisation parameters for the SingleRWA vault constructor.
///
/// This struct mirrors `single_rwa_vault::InitParams` field-for-field so that
/// its XDR encoding is identical when passed via `deploy_v2`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SingleRwaVaultInitParams {
    pub asset: Address,
    pub share_name: String,
    pub share_symbol: String,
    pub share_decimals: u32,
    pub admin: Address,
    pub zkme_verifier: Address,
    pub cooperator: Address,
    pub funding_target: i128,
    pub maturity_date: u64,
    pub min_deposit: i128,
    pub max_deposit_per_user: i128,
    pub early_redemption_fee_bps: u32,
    pub funding_deadline: u64,
    pub rwa_name: String,
    pub rwa_symbol: String,
    pub rwa_document_uri: String,
    pub rwa_category: String,
    pub expected_apy: u32,
}

/// Parameters for batch vault creation (mirrors BatchVaultParams in Solidity).
#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchVaultParams {
    pub asset: Address,
    pub name: String,
    pub symbol: String,
    pub rwa_name: String,
    pub rwa_symbol: String,
    pub rwa_document_uri: String,
    pub rwa_category: String,
    pub expected_apy: u32,
    pub maturity_date: u64,
    pub funding_deadline: u64,
    pub funding_target: i128,
    pub min_deposit: i128,
    pub max_deposit_per_user: i128,
    pub early_redemption_fee_bps: u32,
}

/// Parameters for `create_single_rwa_vault_full`.
/// Identical fields to BatchVaultParams but named separately for clarity.
pub type CreateVaultParams = BatchVaultParams;
