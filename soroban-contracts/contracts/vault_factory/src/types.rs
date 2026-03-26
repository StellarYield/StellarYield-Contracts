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
    pub lock_up_period: u64,
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
    pub lock_up_period: u64,
}

/// Parameters for `create_single_rwa_vault_full`.
/// Identical fields to BatchVaultParams but named separately for clarity.
pub type CreateVaultParams = BatchVaultParams;

// ─────────────────────────────────────────────────────────────────────────────
// Role-Based Access Control
// ─────────────────────────────────────────────────────────────────────────────

/// Granular operator role for on-chain access control.
///
/// `FullOperator` is the backward-compatible superrole equivalent to the old
/// boolean `Operator` flag.  Additional roles can be granted for fine-grained
/// permissions over vault creation and factory management.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Role {
    /// Can call `distribute_yield` on managed vaults.
    YieldOperator,
    /// Can call vault lifecycle management functions.
    LifecycleManager,
    /// Can call KYC and compliance functions.
    ComplianceOfficer,
    /// Can call `pause` and `emergency_withdraw` on managed vaults.
    TreasuryManager,
    /// Superrole: grants every role check.  Backward-compatible with the old
    /// binary `Operator` flag — can create vaults and manage the factory.
    FullOperator,
}
