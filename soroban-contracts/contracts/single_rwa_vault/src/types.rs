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
    /// Asset value of `shares` snapshotted at request time. Used at processing
    /// time so that yield distributed (or removed) between request and process
    /// cannot move the payout the user agreed to.
    pub locked_asset_value: i128,
}

/// Statistics about the pending redemption queue.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RedemptionQueueSummary {
    /// Number of requests currently awaiting processing.
    pub pending_count: u32,
    /// Unix timestamp of the oldest pending request (0 if queue empty).
    pub oldest_request_timestamp: u64,
    /// Redemption ID of the oldest pending request.
    pub oldest_request_id: u32,
    /// Total number of shares requested across all pending entries.
    pub total_pending_shares: i128,
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

/// Composite epoch metadata for efficient indexer queries.
/// Returns yield, total shares, and timestamp in a single call.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EpochMetadata {
    pub epoch: u32,
    pub yield_amount: i128,
    pub total_shares: i128,
    pub timestamp: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight view helper structs (front-end UX helpers)
// ─────────────────────────────────────────────────────────────────────────────

/// Read-only preview of the fee charged for an early redemption request.
///
/// All values are expressed in the vault's underlying asset units.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EarlyRedemptionFeePreview {
    /// Gross assets that `shares` would redeem for (before fee).
    pub gross_assets: i128,
    /// Early redemption fee amount (gross_assets * fee_bps / 10_000).
    pub fee_amount: i128,
    /// Net assets paid out (gross_assets - fee_amount).
    pub net_assets: i128,
    /// Fee rate in basis points applied in the preview.
    pub fee_bps: u32,
}

/// Per-epoch pending yield breakdown item for a user.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PendingYieldEpoch {
    pub epoch: u32,
    pub pending: i128,
}

/// Non-binding heuristic hint of the work required to claim yield for a user.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ClaimCostHint {
    /// Current epoch at time of estimation.
    pub current_epoch: u32,
    /// Cursor used by claiming logic (`last_claimed_epoch`).
    pub last_claimed_epoch: u32,
    /// Number of epochs the claim path is expected to scan.
    pub epochs_scanned: u32,
    /// Number of epochs that have not been marked claimed for the user.
    pub unclaimed_epochs: u32,
}

/// Read-only preview for claiming yield over a bounded epoch range.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ClaimYieldRangePreview {
    /// Total claimable yield over the requested range at call time.
    pub claimable_yield: i128,
    /// Number of epochs iterated (end - start + 1).
    pub epochs_scanned: u32,
}

/// Safe preview result for withdraw/redeem that avoids panics.
/// Returns status code 0 on success, or a non-zero error code on failure.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SafePreviewResult {
    /// The previewed asset/share amount (0 if status_code != 0).
    pub amount: i128,
    /// 0 = success, non-zero = error code (e.g., PreviewZeroAssets = 48).
    pub status_code: u32,
}

/// Per-user deposit preflight result for batched deposit checks.
#[contracttype]
#[derive(Clone, Debug)]
pub struct DepositCheckResult {
    /// User address being checked.
    pub user: Address,
    /// 0 = deposit allowed, non-zero = error code (e.g., BelowMinimumDeposit = 6).
    pub status_code: u32,
    /// Expected share amount if deposit succeeds; 0 if status_code != 0.
    pub expected_shares: i128,
}

/// Reason codes for `can_request_early_redemption`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum EarlyRedemptionPrecheckReason {
    /// Vault is not in Active state.
    NotActive,
    /// Withdraw/redeem is currently frozen.
    Frozen,
    /// Address is blacklisted.
    Blacklisted,
    /// Requested shares is zero/negative.
    ZeroAmount,
    /// Caller does not have enough share balance.
    InsufficientBalance,
    /// Shares are too small to redeem into non-zero assets at current price.
    TooSmall,
}

/// Structured result for `can_request_early_redemption`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum EarlyRedemptionPrecheckResult {
    Pass,
    Fail(EarlyRedemptionPrecheckReason),
}

/// One-call summary view for a user's core position.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserOverview {
    pub share_balance: i128,
    pub pending_yield: i128,
    pub total_deposited: i128,
    pub is_blacklisted: bool,
    pub is_kyc_verified: bool,
}

/// High-level vault metadata for one-call client initialization.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VaultOverview {
    pub state: VaultState,
    pub paused: bool,
    pub asset: Address,
    pub total_assets: i128,
    pub total_supply: i128,
    pub current_epoch: u32,
    pub maturity_date: u64,
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-epoch activity tracking for audit trail and analytics
// ─────────────────────────────────────────────────────────────────────────────

/// Aggregate activity counters for a single epoch (or lifetime).
///
/// Stored in persistent storage keyed by epoch number.  Lifetime totals are
/// stored under `ActivityDataKey::LifetimeActivity`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EpochActivity {
    pub deposits_count: u32,
    pub deposits_volume: i128,
    pub withdrawals_count: u32,
    pub withdrawals_volume: i128,
    pub transfers_count: u32,
    pub transfers_volume: i128,
    pub redemptions_count: u32,
    pub redemptions_volume: i128,
    pub yield_claims_count: u32,
    pub yield_claims_volume: i128,
    pub new_investors: u32,
    pub exiting_investors: u32,
}

impl EpochActivity {
    pub fn zero() -> Self {
        EpochActivity {
            deposits_count: 0,
            deposits_volume: 0,
            withdrawals_count: 0,
            withdrawals_volume: 0,
            transfers_count: 0,
            transfers_volume: 0,
            redemptions_count: 0,
            redemptions_volume: 0,
            yield_claims_count: 0,
            yield_claims_volume: 0,
            new_investors: 0,
            exiting_investors: 0,
        }
    }
}

/// A pending multi-sig emergency withdrawal proposal.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyProposal {
    pub recipient: Address,
    pub proposed_at: u64,
    pub executed: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface IDs for supports_interface (#299)
// ─────────────────────────────────────────────────────────────────────────────

pub const INTERFACE_BASE: u32 = 1;
pub const INTERFACE_VAULT_ERC4626: u32 = 2;
pub const INTERFACE_YIELD_ACCOUNTING: u32 = 3;
pub const INTERFACE_EARLY_REDEMPTION: u32 = 4;
pub const INTERFACE_RBAC: u32 = 5;
pub const INTERFACE_TIMELOCK: u32 = 6;
pub const INTERFACE_EMERGENCY: u32 = 7;
pub const INTERFACE_ACTIVITY_TRACKING: u32 = 8;
