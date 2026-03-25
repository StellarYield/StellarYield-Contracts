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
    /// Share token decimal places in the minted vault shares.
    ///
    /// Default in `create_single_rwa_vault` is SEP-41 standard 7.
    /// For non-USDC assets, set this explicitly to the desired precision
    /// to avoid scaling issues between asset decimals and share decimals.
    pub share_decimals: u32,
}

/// Parameters for `create_single_rwa_vault_full`.
/// Identical fields to BatchVaultParams but named separately for clarity.
pub type CreateVaultParams = BatchVaultParams;
