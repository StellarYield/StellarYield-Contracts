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

use soroban_sdk::{contracttype, panic_with_error, Address, Env, String, Vec};

use crate::errors::Error;
use crate::types::{EmergProposal, RedemRequest, Role, VaultState};

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

/// Storage keys for vault configuration and metadata (Instance storage).
#[contracttype]
#[derive(Clone)]
pub enum ConfigKey {
    ShName,
    ShSymb,
    ShDec,
    Asset,
    Admin,
    Verifier,
    Coop,
    RwaName,
    RwaSymb,
    RwaUri,
    RwaCat,
    Apy,
    Target,
    Maturity,
    MinDep,
    MaxUser,
    RedemFee,
    Ver,
    SchemaVersion,
    Deadline,
    EmSigners,
    EmThreshold,
}

/// Storage keys for dynamic vault state (Instance storage).
#[contracttype]
#[derive(Clone)]
pub enum StateKey {
    State,
    Paused,
    Flags,
    ActivateTime,
    Locked,
    Epoch,
    YieldDist,
    Supply,
    TDep,
    RedemCount,
    TransferKyc,
    EmergBalance,
    EmTotalSupSnap,
    EmPropCount,
}

/// Storage keys for user-specific data (Persistent storage).
#[contracttype]
#[derive(Clone)]
pub enum UserKey {
    Balance(Address),
    Allow(Address, Address),
    UDep(Address),
    YieldClaimed(Address),
    LastClaimed(Address),
    LastInteract(Address),
    EscrowShares(Address),
    BList(Address),
    Role(Address, Role),
    HasClaimEmerg(Address),
}

/// Storage keys for per-epoch data (Persistent storage).
#[contracttype]
#[derive(Clone)]
pub enum EpochKey {
    EpYield(u32),
    EpShares(u32),
    EpTime(u32),
    HasClaimed(Address, u32),
    UserShares(Address, u32),
    HasSnapshot(Address, u32),
}

/// Storage keys for proposals and requests (Persistent storage).
#[contracttype]
#[derive(Clone)]
pub enum ProposalKey {
    EmergProp(u32),
    EPAppr(u32),
    RedemReq(u32),
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
    let key = UserKey::Balance(addr.clone());
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
/// `HasClm` expires the contract will treat a previously-claimed epoch
/// as unclaimed and allow a second payout.  Bumping every related key on every
/// write keeps the TTL well above the BALANCE_LIFETIME_THRESHOLD (~60 days)
/// and eliminates that class of bug.
#[allow(dead_code)]
pub fn bump_user_data(e: &Env, addr: &Address, epoch: u32) {
    let epoch_keys = [
        EpochKey::HasClaimed(addr.clone(), epoch),
        EpochKey::UserShares(addr.clone(), epoch),
        EpochKey::HasSnapshot(addr.clone(), epoch),
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
        UserKey::YieldClaimed(addr.clone()),
        UserKey::LastInteract(addr.clone()),
        UserKey::LastClaimed(addr.clone()),
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

macro_rules! config_get {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env) -> $ty {
            e.storage().instance().get(&ConfigKey::$key).unwrap()
        }
    };
}
macro_rules! config_put {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env, val: $ty) {
            e.storage().instance().set(&ConfigKey::$key, &val);
        }
    };
}

macro_rules! state_get {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env) -> $ty {
            e.storage().instance().get(&StateKey::$key).unwrap()
        }
    };
}
macro_rules! state_put {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env, val: $ty) {
            e.storage().instance().set(&StateKey::$key, &val);
        }
    };
}

// Share token metadata
config_get!(get_share_name, ShName, String);
config_put!(put_share_name, ShName, String);
config_get!(get_share_symbol, ShSymb, String);
config_put!(put_share_symbol, ShSymb, String);
config_get!(get_share_decimals, ShDec, u32);
config_put!(put_share_decimals, ShDec, u32);

// Asset
config_get!(get_asset, Asset, Address);
config_put!(put_asset, Asset, Address);

// Admin
config_get!(get_admin, Admin, Address);
config_put!(put_admin, Admin, Address);

// zkMe
config_get!(get_zkme_verifier, Verifier, Address);
config_put!(put_zkme_verifier, Verifier, Address);
config_get!(get_cooperator, Coop, Address);
config_put!(put_cooperator, Coop, Address);

// RWA
config_get!(get_rwa_name, RwaName, String);
config_put!(put_rwa_name, RwaName, String);
config_get!(get_rwa_symbol, RwaSymb, String);
config_put!(put_rwa_symbol, RwaSymb, String);
config_get!(get_rwa_document_uri, RwaUri, String);
config_put!(put_rwa_document_uri, RwaUri, String);
config_get!(get_rwa_category, RwaCat, String);
config_put!(put_rwa_category, RwaCat, String);
config_get!(get_expected_apy, Apy, u32);
config_put!(put_expected_apy, Apy, u32);

// Config
config_get!(get_funding_target, Target, i128);
config_put!(put_funding_target, Target, i128);
config_get!(get_maturity_date, Maturity, u64);
config_put!(put_maturity_date, Maturity, u64);

pub fn get_fund_deadline(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&ConfigKey::Deadline)
        .unwrap_or(0)
}
pub fn put_fund_deadline(e: &Env, val: u64) {
    e.storage().instance().set(&ConfigKey::Deadline, &val);
}

config_get!(get_min_deposit, MinDep, i128);
config_put!(put_min_deposit, MinDep, i128);
config_get!(get_max_user_dep, MaxUser, i128);
config_put!(put_max_user_dep, MaxUser, i128);
config_get!(get_redem_fee_bps, RedemFee, u32);
config_put!(put_redem_fee_bps, RedemFee, u32);

// State
state_get!(get_vault_state, State, VaultState);
state_put!(put_vault_state, State, VaultState);
state_get!(get_paused, Paused, bool);
state_put!(put_paused, Paused, bool);
state_get!(get_freeze_flags, Flags, u32);
state_put!(put_freeze_flags, Flags, u32);
state_get!(get_locked, Locked, bool);
state_put!(put_locked, Locked, bool);

pub fn get_activation_timestamp(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&StateKey::ActivateTime)
        .unwrap_or(0)
}
pub fn put_activation_timestamp(e: &Env, val: u64) {
    e.storage().instance().set(&StateKey::ActivateTime, &val);
}

// Epoch / yield (global)
state_get!(get_current_epoch, Epoch, u32);
state_put!(put_current_epoch, Epoch, u32);
state_get!(get_total_yield_distributed, YieldDist, i128);
state_put!(put_total_yield_distributed, YieldDist, i128);

// Supply
state_get!(get_total_supply, Supply, i128);
state_put!(put_total_supply, Supply, i128);

// TDep (principal tracking)
state_get!(get_total_deposited, TDep, i128);
state_put!(put_total_deposited, TDep, i128);

// RedemCount
state_get!(get_redemption_counter, RedemCount, u32);
state_put!(put_redemption_counter, RedemCount, u32);

// Versioning
config_get!(get_contract_version, Ver, u32);
config_put!(put_contract_version, Ver, u32);
config_get!(get_storage_schema_version, SchemaVersion, u32);
config_put!(put_storage_schema_version, SchemaVersion, u32);

// ─────────────────────────────────────────────────────────────────────────────
// Operator (instance storage — same lifetime as admin)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Granular RBAC helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns `true` when `addr` has been granted `role` in instance storage.
pub fn has_role(e: &Env, addr: &Address, role: Role) -> bool {
    if role == Role::FullOperator {
        let admin = get_admin(e);
        if &admin == addr {
            return true;
        }
    }
    e.storage()
        .instance()
        .get(&UserKey::Role(addr.clone(), role))
        .unwrap_or(false)
}

pub fn add_role(e: &Env, addr: Address, role: Role) {
    e.storage()
        .instance()
        .set(&UserKey::Role(addr, role), &true);
}

pub fn remove_role(e: &Env, addr: Address, role: Role) {
    e.storage().instance().remove(&UserKey::Role(addr, role));
}

// ─── Backward-compatible operator wrappers ───────────────────────────────────
//
// `set_operator` / `is_operator` on the public interface map to `FullOperator`.
// Existing deployments and tooling that call these functions continue to work
// without change; they effectively grant/revoke the superrole.

/// Returns `true` when `addr` holds the `FullOperator` superrole.
pub fn get_operator(e: &Env, addr: &Address) -> bool {
    has_role(e, addr, Role::FullOperator)
}

/// Grant or revoke the `FullOperator` superrole for `addr`.
pub fn put_operator(e: &Env, addr: Address, val: bool) {
    if val {
        add_role(e, addr, Role::FullOperator);
    } else {
        remove_role(e, addr, Role::FullOperator);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-epoch data (instance, keyed by epoch number — small integers)
// ─────────────────────────────────────────────────────────────────────────────
// Epoch yield / share tracking (per epoch)
pub fn get_epoch_yield(e: &Env, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&EpochKey::EpYield(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_yield(e: &Env, epoch: u32, val: i128) {
    e.storage()
        .persistent()
        .set(&EpochKey::EpYield(epoch), &val);
}

pub fn get_epoch_shares(e: &Env, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&EpochKey::EpShares(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_shares(e: &Env, epoch: u32, val: i128) {
    e.storage()
        .persistent()
        .set(&EpochKey::EpShares(epoch), &val);
}

pub fn get_epoch_time(e: &Env, epoch: u32) -> u64 {
    e.storage()
        .persistent()
        .get(&EpochKey::EpTime(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_time(e: &Env, epoch: u32, val: u64) {
    e.storage().persistent().set(&EpochKey::EpTime(epoch), &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Share token balance / allowance (Persistent storage)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_balance(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&UserKey::Balance(addr.clone()))
        .unwrap_or(0)
}
pub fn put_balance(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&UserKey::Balance(addr.clone()), &val);
}

/// Persistent allowance record that couples the approved amount with its
/// expiration ledger, enabling on-chain expiry enforcement (SEP-41 §3.4).
#[contracttype]
#[derive(Clone)]
pub struct AllowData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user persistent data
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_share_balance(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::Balance(addr.clone()))
        .unwrap_or(0)
}
pub fn put_share_balance(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&Key::Balance(addr.clone()), &val);
}

/// Returns the current allowance for `(owner, spender)`.
/// Returns 0 if no allowance is recorded **or** if it has expired
/// (`expiration_ledger < current ledger sequence`).
pub fn get_share_allowance(e: &Env, owner: &Address, spender: &Address) -> i128 {
    let key = Key::Allow(owner.clone(), spender.clone());
    match e.storage().persistent().get::<_, AllowData>(&key) {
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
    let key = Key::Allow(owner.clone(), spender.clone());
    // Read back the expiration that was set when the allowance was approved.
    let expiration_ledger = e
        .storage()
        .persistent()
        .get::<_, AllowData>(&key)
        .map(|d| d.expiration_ledger)
        .unwrap_or(0);
    e.storage().persistent().set(
        &key,
        &AllowData {
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
pub fn get_allowance(e: &Env, owner: Address, spender: Address) -> AllowData {
    let key = UserKey::Allow(owner, spender);
    e.storage().persistent().get(&key).unwrap_or(AllowData {
        amount: 0,
        expiration_ledger: 0,
    })
}

pub fn put_allowance(
    e: &Env,
    owner: Address,
    spender: Address,
    amount: i128,
    expiration_ledger: u32,
) {
    if amount > 0 && expiration_ledger < e.ledger().sequence() {
        panic_with_error!(e, crate::errors::VaultError::InvalidExpiration);
    }
    let key = UserKey::Allow(owner, spender);
    let val = AllowData {
        amount,
        expiration_ledger,
    };
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
// User data tracking (Persistent storage)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_user_deposited(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&UserKey::UDep(addr.clone()))
        .unwrap_or(0)
}
pub fn put_user_deposited(e: &Env, addr: &Address, val: i128) {
    let key = UserKey::UDep(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

// User-specific yield claim status
pub fn get_yield_claimed(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&UserKey::YieldClaimed(addr.clone()))
        .unwrap_or(0)
}
pub fn put_yield_claimed(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&UserKey::YieldClaimed(addr.clone()), &val);
}

pub fn get_has_claimed(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&EpochKey::HasClaimed(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_claimed(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = EpochKey::HasClaimed(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
}

pub fn get_user_total_claimed(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&UserKey::YieldClaimed(addr.clone()))
        .unwrap_or(0)
}

pub fn get_last_claimed_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&UserKey::LastClaimed(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_claimed_epoch(e: &Env, addr: &Address, epoch: u32) {
    e.storage()
        .persistent()
        .set(&UserKey::LastClaimed(addr.clone()), &epoch);
}

// User share snapshots (per epoch)
pub fn get_user_shares(e: &Env, addr: &Address, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&EpochKey::UserShares(addr.clone(), epoch))
        .unwrap_or(0)
}
pub fn put_user_shares(e: &Env, addr: &Address, epoch: u32, val: i128) {
    let key = EpochKey::UserShares(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
}

pub fn get_user_has_snapshot(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&EpochKey::HasSnapshot(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_user_has_snapshot(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = EpochKey::HasSnapshot(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
}

pub fn get_last_interact_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&UserKey::LastInteract(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_interact_epoch(e: &Env, addr: &Address, epoch: u32) {
    let key = UserKey::LastInteract(addr.clone());
    e.storage().persistent().set(&key, &epoch);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Redemption requests (persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_redemption_request(e: &Env, id: u32) -> RedemRequest {
    e.storage()
        .persistent()
        .get(&ProposalKey::RedemReq(id))
        .unwrap_or_else(|| panic_with_error!(e, Error::InvalidRedemptionRequest))
}

pub fn put_redemption_request(e: &Env, id: u32, req: RedemRequest) {
    e.storage()
        .persistent()
        .set(&ProposalKey::RedemReq(id), &req);
    e.storage().persistent().extend_ttl(
        &ProposalKey::RedemReq(id),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_escrowed_shares(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&UserKey::EscrowShares(addr.clone()))
        .unwrap_or(0)
}

pub fn put_escrowed_shares(e: &Env, addr: &Address, amount: i128) {
    let key = UserKey::EscrowShares(addr.clone());
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
        .get(&StateKey::TransferKyc)
        .unwrap_or(true)
}

pub fn put_transfer_requires_kyc(e: &Env, val: bool) {
    e.storage().instance().set(&StateKey::TransferKyc, &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blacklist (persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_blacklisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&UserKey::BList(addr.clone()))
        .unwrap_or(false)
}

pub fn put_blacklisted(e: &Env, addr: &Address, status: bool) {
    e.storage()
        .persistent()
        .set(&UserKey::BList(addr.clone()), &status);
    e.storage().persistent().extend_ttl(
        &UserKey::BList(addr.clone()),
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
        .get(&StateKey::EmergBalance)
        .unwrap_or(0)
}

pub fn put_emergency_balance(e: &Env, val: i128) {
    e.storage().instance().set(&StateKey::EmergBalance, &val);
}

pub fn get_emergency_total_supply_snapshot(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&StateKey::EmTotalSupSnap)
        .unwrap_or(0)
}

pub fn put_emergency_total_supply_snapshot(e: &Env, val: i128) {
    e.storage().instance().set(&StateKey::EmTotalSupSnap, &val);
}

pub fn get_has_claimed_emergency(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&UserKey::HasClaimEmerg(addr.clone()))
        .unwrap_or(false)
}

pub fn put_has_claimed_emergency(e: &Env, addr: &Address, val: bool) {
    let key = UserKey::HasClaimEmerg(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Emergency multi-sig (instance storage for config, persistent for proposals)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns true when a signer set has been configured via `set_emergency_signers`.
pub fn has_emergency_signers(e: &Env) -> bool {
    e.storage().instance().has(&ConfigKey::EmSigners)
}

pub fn get_emergency_signers(e: &Env) -> Vec<Address> {
    e.storage().instance().get(&ConfigKey::EmSigners).unwrap()
}

pub fn put_emergency_signers(e: &Env, signers: Vec<Address>) {
    e.storage().instance().set(&ConfigKey::EmSigners, &signers);
}

pub fn get_emergency_threshold(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&ConfigKey::EmThreshold)
        .unwrap_or(0)
}

pub fn put_emergency_threshold(e: &Env, threshold: u32) {
    e.storage()
        .instance()
        .set(&ConfigKey::EmThreshold, &threshold);
}

pub fn get_emergency_proposal_counter(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&StateKey::EmPropCount)
        .unwrap_or(0)
}

pub fn put_emergency_proposal_counter(e: &Env, val: u32) {
    e.storage().instance().set(&StateKey::EmPropCount, &val);
}

pub fn get_emergency_proposal(e: &Env, id: u32) -> Option<EmergProposal> {
    e.storage().persistent().get(&ProposalKey::EmergProp(id))
}

pub fn put_emergency_proposal(e: &Env, id: u32, prop: &EmergProposal) {
    let key = ProposalKey::EmergProp(id);
    e.storage().persistent().set(&key, prop);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_emergency_proposal_approval(e: &Env, id: u32) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&ProposalKey::EPAppr(id))
        .unwrap_or_else(|| Vec::new(e))
}

pub fn put_emergency_proposal_approval(e: &Env, id: u32, signers: Vec<Address>) {
    let key = ProposalKey::EPAppr(id);
    e.storage().persistent().set(&key, &signers);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}
