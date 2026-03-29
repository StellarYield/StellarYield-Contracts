//! Shared types used across the SingleRWA_Vault contract.

use soroban_sdk::{contracttype, Address, Bytes, String};

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation parameters struct
// (Soroban limits contract functions to ≤10 arguments; using a struct
//  lets us pass all init data in a single argument.)
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct InitParams {
    // Asset token address (e.g. USDC)
    pub asset: Address,
    // Share-token metadata
    pub share_name: String,
    pub share_symbol: String,
    pub share_decimals: u32,
    // Admin / KYC
    pub admin: Address,
    pub zkme_verifier: Address,
    pub cooperator: Address,
    // Vault configuration
    pub funding_target: i128,
    pub maturity_date: u64,
    pub min_deposit: i128,
    pub max_deposit_per_user: i128,
    pub early_redemption_fee_bps: u32,
    /// Unix timestamp after which funding can be cancelled if target not met.
    pub funding_deadline: u64,
    // RWA details
    pub rwa_name: String,
    pub rwa_symbol: String,
    pub rwa_document_uri: String,
    pub rwa_category: String,
    pub expected_apy: u32,
    // Timelock configuration
    /// Delay in seconds for critical admin operations (default: 48 hours)
    pub timelock_delay: u64,
    /// Yield vesting period in seconds (0 = instant claiming for backward compatibility)
    pub yield_vesting_period: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault state enum
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum VaultState {
    /// Accepting deposits to reach funding target.
    Funding,
    /// RWA investment is active, generating yield.
    Active,
    /// Investment matured, full redemptions enabled.
    Matured,
    /// Vault is closed.
    Closed,
    /// Funding failed (deadline passed without meeting target); refunds available.
    Cancelled,
    /// Emergency mode: users can claim pro-rata share of remaining assets.
    Emergency,
}

// ─────────────────────────────────────────────────────────────────────────────
// RWA details struct (returned by get_rwa_details)
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct RwaDetails {
    pub name: String,
    pub symbol: String,
    pub document_uri: String,
    pub category: String,
    pub expected_apy: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Role-Based Access Control
// ─────────────────────────────────────────────────────────────────────────────

/// Granular operator role for on-chain access control.
///
/// Assign the narrowest role each team member needs rather than handing out
/// the full-operator key.  `FullOperator` is the backward-compatible superrole
/// and passes every role check — it is equivalent to the old boolean
/// `Operator` flag.
///
/// Role → permitted functions
/// - `YieldOperator`     → `distribute_yield`
/// - `LifecycleManager`  → `activate_vault`, `cancel_funding`, `mature_vault`,
///                          `close_vault`, `set_maturity_date`, `set_deposit_limits`,
///                          `set_funding_target`, `process_early_redemption`,
///                          `reject_early_redemption`, `set_early_redemption_fee`
/// - `ComplianceOfficer` → `set_zkme_verifier`, `set_cooperator`,
///                          `set_blacklisted`, `set_transfer_requires_kyc`
/// - `TreasuryManager`   → `pause`, `emergency_withdraw`
/// - `FullOperator`      → all of the above (backward-compatible superrole)
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Role {
    /// Can call `distribute_yield` only.
    YieldOperator,
    /// Can call vault lifecycle management functions.
    LifecycleManager,
    /// Can call KYC and compliance functions.
    ComplianceOfficer,
    /// Can call `pause` and `emergency_withdraw`.
    TreasuryManager,
    /// Superrole: grants every role check.  Backward-compatible with the old
    /// binary `Operator` flag.
    FullOperator,
}

// ─────────────────────────────────────────────────────────────────────────────
// Redemption request
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct RedemptionRequest {
    pub user: Address,
    pub shares: i128,
    pub request_time: u64,
    pub processed: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Epoch data structs (for historical yield queries)
// ─────────────────────────────────────────────────────────────────────────────

/// Per-epoch yield data returned by historical query functions.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EpochData {
    pub epoch: u32,
    pub yield_amount: i128,
    pub total_shares: i128,
    /// Computed: yield_amount * PRECISION / total_shares; 0 if total_shares == 0.
    pub yield_per_share: i128,
    /// Unix timestamp when this epoch was created by distribute_yield.
    pub timestamp: u64,
}

/// Aggregate yield statistics for the vault.
#[contracttype]
#[derive(Clone, Debug)]
pub struct YieldSummary {
    pub total_epochs: u32,
    pub total_yield_distributed: i128,
    pub average_yield_per_epoch: i128,
    pub latest_epoch_yield: i128,
    pub earliest_epoch: u32,
    pub latest_epoch: u32,
}

/// Per-epoch yield breakdown for a specific user.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserEpochYield {
    pub epoch: u32,
    pub user_shares: i128,
    pub yield_earned: i128,
    pub claimed: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Timelock mechanism for critical admin operations
// ─────────────────────────────────────────────────────────────────────────────

/// Types of critical operations that require timelock protection.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ActionType {
    EmergencyWithdraw,
    TransferAdmin,
    Upgrade,
    WasmHashUpdate,
}

/// A timelocked action that delays execution of critical operations.
#[contracttype]
#[derive(Clone, Debug)]
pub struct TimelockAction {
    pub action_type: ActionType,
    pub data: Bytes,
    pub proposed_at: u64,
    pub executable_at: u64,
    pub executed: bool,
    pub cancelled: bool,
}

/// A pending multi-sig emergency withdrawal proposal.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyProposal {
    pub recipient: Address,
    pub proposed_at: u64,
    pub executed: bool,
}
