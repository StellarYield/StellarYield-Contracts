//! Soroban storage layer for SingleRWA_Vault.
//!
//! Storage tier decisions follow the Stellar best-practice guide:
//!
//! • **Instance** – global shared config that must never be archived while
//!   the contract is live (admin, pause flag, vault state, epoch counters …)
//! • **Persistent** – per-user data that should survive long term (balances,
//!   allowances, snapshots, yield-claim flags …)
//! • **Temporary** – nothing here (all data is permanent in this contract)
//!
//! TTL constants assume ~5-second ledger close times.
//! INSTANCE_BUMP_AMOUNT  ≈ 30 days
//! BALANCE_BUMP_AMOUNT   ≈ 60 days

use soroban_sdk::{contracttype, panic_with_error, Address, Env, String};

use crate::errors::Error;
use crate::types::{RedemptionRequest, Role, VaultState};

// ─────────────────────────────────────────────────────────────────────────────
// TTL constants
// ─────────────────────────────────────────────────────────────────────────────

pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 518400; // ~30 days at 5s/ledger
pub const INSTANCE_BUMP_AMOUNT: u32 = 535000; // bump target

pub const BALANCE_LIFETIME_THRESHOLD: u32 = 1036800; // ~60 days
pub const BALANCE_BUMP_AMOUNT: u32 = 1069000;

// ─────────────────────────────────────────────────────────────────────────────
// Storage key enum
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // --- Share token metadata ---
    ShareName,
    ShareSymbol,
    ShareDecimals,

    // --- Asset ---
    Asset,

    // --- Admin / operators ---
    Admin,
    /// Granular RBAC role assignment: (address, role) → bool.
    /// Replaces the old binary `Operator(Address)` key.
    Role(Address, Role),

    // --- zkMe ---
    ZkmeVerifier,
    Cooperator,

    // --- RWA details ---
    RwaName,
    RwaSymbol,
    RwaDocumentUri,
    RwaCategory,
    ExpectedApy,

    // --- Vault config ---
    FundingTarget,
    MaturityDate,
    MinDeposit,
    MaxDepositPerUser,
    EarlyRedemptionFeeBps,
    LockUpPeriod,

    // --- Vault state ---
    VaultState,
    Paused,
    ActivationTimestamp,
    /// Reentrancy lock — true while a guarded function is executing.
    Locked,
    /// Unix timestamp deadline for funding; 0 means no deadline.
    FundingDeadline,

    // --- Epoch / yield ---
    CurrentEpoch,
    TotalYieldDistributed,
    EpochYield(u32),
    EpochTotalShares(u32),
    TotalYieldClaimed(Address),
    HasClaimedEpoch(Address, u32),

    // --- User share snapshots ---
    UserSharesAtEpoch(Address, u32),
    HasSnapshotForEpoch(Address, u32),
    LastInteractionEpoch(Address),

    // --- Share token balances / allowances ---
    Balance(Address),
    Allowance(Address, Address), // (owner, spender)
    TotalSupply,

    // --- User deposit tracking ---
    UserDeposited(Address),
    DepositTimestamp(Address),

    // --- Total deposited principal ---
    TotalDeposited,

    // --- Early redemption ---
    RedemptionCounter,
    RedemptionRequest(u32),
    EscrowedShares(Address),

    // --- Blacklist ---
    Blacklisted(Address),

    // --- Transfer KYC gate ---
    TransferRequiresKyc,

    // --- Emergency pro-rata distribution ---
    EmergencyBalance,
    HasClaimedEmergency(Address),
    EmergencyTotalSupplySnapshot,
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL helpers
// ─────────────────────────────────────────────────────────────────────────────

pub fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

pub fn bump_balance(e: &Env, addr: &Address) {
    let key = DataKey::Balance(addr.clone());
    if e.storage().persistent().has(&key) {
        e.storage()
            .persistent()
            .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
    }
}

/// Extend the TTL for all persistent per-user yield/snapshot entries for a
/// given address and epoch.  Call this any time user data is written so that
/// no entry can silently expire and cause double-claims or missed payouts.
///
/// # Security rationale
/// Stellar persistent storage entries expire when their TTL reaches zero.  If
/// `HasClaimedEpoch` expires the contract will treat a previously-claimed epoch
/// as unclaimed and allow a second payout.  Bumping every related key on every
/// write keeps the TTL well above the BALANCE_LIFETIME_THRESHOLD (~60 days)
/// and eliminates that class of bug.
#[allow(dead_code)]
pub fn bump_user_data(e: &Env, addr: &Address, epoch: u32) {
    let epoch_keys = [
        DataKey::HasClaimedEpoch(addr.clone(), epoch),
        DataKey::UserSharesAtEpoch(addr.clone(), epoch),
        DataKey::HasSnapshotForEpoch(addr.clone(), epoch),
    ];
    for key in &epoch_keys {
        if e.storage().persistent().has(key) {
            e.storage().persistent().extend_ttl(
                key,
                BALANCE_LIFETIME_THRESHOLD,
                BALANCE_BUMP_AMOUNT,
            );
        }
    }

    let addr_keys = [
        DataKey::TotalYieldClaimed(addr.clone()),
        DataKey::LastInteractionEpoch(addr.clone()),
    ];
    for key in &addr_keys {
        if e.storage().persistent().has(key) {
            e.storage().persistent().extend_ttl(
                key,
                BALANCE_LIFETIME_THRESHOLD,
                BALANCE_BUMP_AMOUNT,
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance-stored getters / setters
// (Admin, config, vault state, epoch counters, pause)
// ─────────────────────────────────────────────────────────────────────────────

macro_rules! instance_get {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env) -> $ty {
            e.storage().instance().get(&DataKey::$key).unwrap()
        }
    };
}
macro_rules! instance_put {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env, val: $ty) {
            e.storage().instance().set(&DataKey::$key, &val);
        }
    };
}

// Share token metadata
instance_get!(get_share_name, ShareName, String);
instance_put!(put_share_name, ShareName, String);
instance_get!(get_share_symbol, ShareSymbol, String);
instance_put!(put_share_symbol, ShareSymbol, String);
instance_get!(get_share_decimals, ShareDecimals, u32);
instance_put!(put_share_decimals, ShareDecimals, u32);

// Asset
instance_get!(get_asset, Asset, Address);
instance_put!(put_asset, Asset, Address);

// Admin
instance_get!(get_admin, Admin, Address);
instance_put!(put_admin, Admin, Address);

// zkMe
instance_get!(get_zkme_verifier, ZkmeVerifier, Address);
instance_put!(put_zkme_verifier, ZkmeVerifier, Address);
instance_get!(get_cooperator, Cooperator, Address);
instance_put!(put_cooperator, Cooperator, Address);

// RWA
instance_get!(get_rwa_name, RwaName, String);
instance_put!(put_rwa_name, RwaName, String);
instance_get!(get_rwa_symbol, RwaSymbol, String);
instance_put!(put_rwa_symbol, RwaSymbol, String);
instance_get!(get_rwa_document_uri, RwaDocumentUri, String);
instance_put!(put_rwa_document_uri, RwaDocumentUri, String);
instance_get!(get_rwa_category, RwaCategory, String);
instance_put!(put_rwa_category, RwaCategory, String);
instance_get!(get_expected_apy, ExpectedApy, u32);
instance_put!(put_expected_apy, ExpectedApy, u32);

// Config
instance_get!(get_funding_target, FundingTarget, i128);
instance_put!(put_funding_target, FundingTarget, i128);
instance_get!(get_maturity_date, MaturityDate, u64);
instance_put!(put_maturity_date, MaturityDate, u64);

pub fn get_funding_deadline(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::FundingDeadline)
        .unwrap_or(0)
}
pub fn put_funding_deadline(e: &Env, val: u64) {
    e.storage().instance().set(&DataKey::FundingDeadline, &val);
}

instance_get!(get_min_deposit, MinDeposit, i128);
instance_put!(put_min_deposit, MinDeposit, i128);
instance_get!(get_max_deposit_per_user, MaxDepositPerUser, i128);
instance_put!(put_max_deposit_per_user, MaxDepositPerUser, i128);
instance_get!(get_early_redemption_fee_bps, EarlyRedemptionFeeBps, u32);
instance_put!(put_early_redemption_fee_bps, EarlyRedemptionFeeBps, u32);

pub fn get_lock_up_period(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::LockUpPeriod)
        .unwrap_or(0)
}
pub fn put_lock_up_period(e: &Env, val: u64) {
    e.storage().instance().set(&DataKey::LockUpPeriod, &val);
}

// State
instance_get!(get_vault_state, VaultState, VaultState);
instance_put!(put_vault_state, VaultState, VaultState);
instance_get!(get_paused, Paused, bool);
instance_put!(put_paused, Paused, bool);
instance_get!(get_locked, Locked, bool);
instance_put!(put_locked, Locked, bool);

pub fn get_activation_timestamp(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::ActivationTimestamp)
        .unwrap_or(0)
}
pub fn put_activation_timestamp(e: &Env, val: u64) {
    e.storage()
        .instance()
        .set(&DataKey::ActivationTimestamp, &val);
}

// Epoch / yield (global)
instance_get!(get_current_epoch, CurrentEpoch, u32);
instance_put!(put_current_epoch, CurrentEpoch, u32);
instance_get!(get_total_yield_distributed, TotalYieldDistributed, i128);
instance_put!(put_total_yield_distributed, TotalYieldDistributed, i128);

// TotalSupply
instance_get!(get_total_supply, TotalSupply, i128);
instance_put!(put_total_supply, TotalSupply, i128);

// TotalDeposited (principal tracking)
instance_get!(get_total_deposited, TotalDeposited, i128);
instance_put!(put_total_deposited, TotalDeposited, i128);

// RedemptionCounter
instance_get!(get_redemption_counter, RedemptionCounter, u32);
instance_put!(put_redemption_counter, RedemptionCounter, u32);

// ─────────────────────────────────────────────────────────────────────────────
// Operator (instance storage — same lifetime as admin)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Granular RBAC helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns `true` when `addr` has been granted `role` in instance storage.
pub fn get_role(e: &Env, addr: &Address, role: Role) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Role(addr.clone(), role))
        .unwrap_or(false)
}

/// Grant (`val = true`) or revoke (`val = false`) `role` for `addr`.
pub fn put_role(e: &Env, addr: Address, role: Role, val: bool) {
    if val {
        e.storage()
            .instance()
            .set(&DataKey::Role(addr, role), &true);
    } else {
        e.storage().instance().remove(&DataKey::Role(addr, role));
    }
}

// ─── Backward-compatible operator wrappers ───────────────────────────────────
//
// `set_operator` / `is_operator` on the public interface map to `FullOperator`.
// Existing deployments and tooling that call these functions continue to work
// without change; they effectively grant/revoke the superrole.

/// Returns `true` when `addr` holds the `FullOperator` superrole.
pub fn get_operator(e: &Env, addr: &Address) -> bool {
    get_role(e, addr, Role::FullOperator)
}

/// Grant or revoke the `FullOperator` superrole for `addr`.
pub fn put_operator(e: &Env, addr: Address, val: bool) {
    put_role(e, addr, Role::FullOperator, val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-epoch data (instance, keyed by epoch number — small integers)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_epoch_yield(e: &Env, epoch: u32) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::EpochYield(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_yield(e: &Env, epoch: u32, val: i128) {
    e.storage()
        .instance()
        .set(&DataKey::EpochYield(epoch), &val);
}

pub fn get_epoch_total_shares(e: &Env, epoch: u32) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::EpochTotalShares(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_total_shares(e: &Env, epoch: u32, val: i128) {
    e.storage()
        .instance()
        .set(&DataKey::EpochTotalShares(epoch), &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Allowance data type
// ─────────────────────────────────────────────────────────────────────────────

/// Persistent allowance record that couples the approved amount with its
/// expiration ledger, enabling on-chain expiry enforcement (SEP-41 §3.4).
#[contracttype]
#[derive(Clone)]
pub struct AllowanceData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user persistent data
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_share_balance(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Balance(addr.clone()))
        .unwrap_or(0)
}
pub fn put_share_balance(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&DataKey::Balance(addr.clone()), &val);
}

/// Returns the current allowance for `(owner, spender)`.
/// Returns 0 if no allowance is recorded **or** if it has expired
/// (`expiration_ledger < current ledger sequence`).
pub fn get_share_allowance(e: &Env, owner: &Address, spender: &Address) -> i128 {
    let key = DataKey::Allowance(owner.clone(), spender.clone());
    match e.storage().persistent().get::<_, AllowanceData>(&key) {
        Some(data) => {
            if e.ledger().sequence() > data.expiration_ledger {
                0 // allowance has expired
            } else {
                data.amount
            }
        }
        None => 0,
    }
}

/// Decrements an existing allowance to `new_amount`, preserving the stored
/// `expiration_ledger`.  Only call this after confirming the allowance is
/// sufficient and non-expired via `get_share_allowance`.
pub fn put_share_allowance(e: &Env, owner: &Address, spender: &Address, new_amount: i128) {
    let key = DataKey::Allowance(owner.clone(), spender.clone());
    // Read back the expiration that was set when the allowance was approved.
    let expiration_ledger = e
        .storage()
        .persistent()
        .get::<_, AllowanceData>(&key)
        .map(|d| d.expiration_ledger)
        .unwrap_or(0);
    e.storage().persistent().set(
        &key,
        &AllowanceData {
            amount: new_amount,
            expiration_ledger,
        },
    );
    // Keep the entry alive until it naturally expires.
    let current = e.ledger().sequence();
    if expiration_ledger > current {
        let live_for = expiration_ledger - current + 1;
        e.storage()
            .persistent()
            .extend_ttl(&key, live_for, live_for);
    }
}

/// Stores a fresh allowance with an on-chain `expiration_ledger` and sets the
/// persistent entry TTL to match, enabling automatic ledger-level cleanup.
pub fn put_share_allowance_with_expiry(
    e: &Env,
    owner: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = DataKey::Allowance(owner.clone(), spender.clone());
    e.storage().persistent().set(
        &key,
        &AllowanceData {
            amount,
            expiration_ledger,
        },
    );
    // Align the persistent TTL with the expiration so Soroban's archival
    // mechanism cleans up the entry automatically once it expires.
    let current = e.ledger().sequence();
    if expiration_ledger >= current {
        let live_for = expiration_ledger - current + 1;
        e.storage()
            .persistent()
            .extend_ttl(&key, live_for, live_for);
    }
}

pub fn get_user_deposited(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::UserDeposited(addr.clone()))
        .unwrap_or(0)
}
pub fn put_user_deposited(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&DataKey::UserDeposited(addr.clone()), &val);
    e.storage().persistent().extend_ttl(
        &DataKey::UserDeposited(addr.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_deposit_timestamp(e: &Env, addr: &Address) -> u64 {
    e.storage()
        .persistent()
        .get(&DataKey::DepositTimestamp(addr.clone()))
        .unwrap_or(0)
}
pub fn put_deposit_timestamp(e: &Env, addr: &Address, val: u64) {
    e.storage()
        .persistent()
        .set(&DataKey::DepositTimestamp(addr.clone()), &val);
    e.storage().persistent().extend_ttl(
        &DataKey::DepositTimestamp(addr.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_total_yield_claimed(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::TotalYieldClaimed(addr.clone()))
        .unwrap_or(0)
}
pub fn put_total_yield_claimed(e: &Env, addr: &Address, val: i128) {
    let key = DataKey::TotalYieldClaimed(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_has_claimed_epoch(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&DataKey::HasClaimedEpoch(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_claimed_epoch(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = DataKey::HasClaimedEpoch(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_user_shares_at_epoch(e: &Env, addr: &Address, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::UserSharesAtEpoch(addr.clone(), epoch))
        .unwrap_or(0)
}
pub fn put_user_shares_at_epoch(e: &Env, addr: &Address, epoch: u32, val: i128) {
    let key = DataKey::UserSharesAtEpoch(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_has_snapshot_for_epoch(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&DataKey::HasSnapshotForEpoch(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_snapshot_for_epoch(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = DataKey::HasSnapshotForEpoch(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_last_interaction_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&DataKey::LastInteractionEpoch(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_interaction_epoch(e: &Env, addr: &Address, val: u32) {
    let key = DataKey::LastInteractionEpoch(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Redemption requests (persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_redemption_request(e: &Env, id: u32) -> RedemptionRequest {
    e.storage()
        .persistent()
        .get(&DataKey::RedemptionRequest(id))
        .unwrap_or_else(|| panic_with_error!(e, Error::InvalidRedemptionRequest))
}
pub fn put_redemption_request(e: &Env, id: u32, req: RedemptionRequest) {
    e.storage()
        .persistent()
        .set(&DataKey::RedemptionRequest(id), &req);
    e.storage().persistent().extend_ttl(
        &DataKey::RedemptionRequest(id),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_escrowed_shares(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::EscrowedShares(addr.clone()))
        .unwrap_or(0)
}

pub fn put_escrowed_shares(e: &Env, addr: &Address, amount: i128) {
    let key = DataKey::EscrowedShares(addr.clone());
    e.storage().persistent().set(&key, &amount);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer KYC gate (instance storage)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns whether share transfers require the recipient to be KYC-verified.
/// Defaults to `true` so that existing deployments without the key set are
/// safe-by-default (KYC required).
pub fn get_transfer_requires_kyc(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::TransferRequiresKyc)
        .unwrap_or(true)
}

pub fn put_transfer_requires_kyc(e: &Env, val: bool) {
    e.storage()
        .instance()
        .set(&DataKey::TransferRequiresKyc, &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blacklist (persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_blacklisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&DataKey::Blacklisted(addr.clone()))
        .unwrap_or(false)
}

pub fn put_blacklisted(e: &Env, addr: &Address, status: bool) {
    e.storage()
        .persistent()
        .set(&DataKey::Blacklisted(addr.clone()), &status);
    e.storage().persistent().extend_ttl(
        &DataKey::Blacklisted(addr.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Emergency pro-rata distribution (instance + persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_emergency_balance(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::EmergencyBalance)
        .unwrap_or(0)
}

pub fn put_emergency_balance(e: &Env, val: i128) {
    e.storage().instance().set(&DataKey::EmergencyBalance, &val);
}

pub fn get_emergency_total_supply_snapshot(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::EmergencyTotalSupplySnapshot)
        .unwrap_or(0)
}

pub fn put_emergency_total_supply_snapshot(e: &Env, val: i128) {
    e.storage()
        .instance()
        .set(&DataKey::EmergencyTotalSupplySnapshot, &val);
}

pub fn get_has_claimed_emergency(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&DataKey::HasClaimedEmergency(addr.clone()))
        .unwrap_or(false)
}

pub fn put_has_claimed_emergency(e: &Env, addr: &Address, val: bool) {
    let key = DataKey::HasClaimedEmergency(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}
