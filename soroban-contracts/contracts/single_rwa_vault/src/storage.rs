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

#[contracttype]
#[derive(Clone)]
pub enum Key {
    // --- Share token metadata ---
    ShName,
    ShSymb,
    ShDec,

    // --- Asset ---
    Asset,

    // --- Admin / operators ---
    Admin,
    Role(Address, Role),

    // --- zkMe ---
    Verifier,
    Coop,

    // --- RWA details ---
    RwaName,
    RwaSymb,
    RwaUri,
    RwaCat,
    Apy,

    // --- Vault config ---
    Target,
    Maturity,
    MinDep,
    MaxUser,
    RedemFee,

    // --- Vault state ---
    State,
    Paused,
    Flags,
    ActTime,
    Locked,
    Deadline,

    // --- Versioning ---
    Ver,
    SchVer,

    // --- Epoch / yield ---
    Epoch,
    YieldDist,
    EpYield(u32),
    EpShares(u32),
    EpTime(u32),
    YldClm(Address),
    HasClm(Address, u32),
    LastClm(Address),

    // --- User share snapshots ---
    UShares(Address, u32),
    USnap(Address, u32),
    LInter(Address),

    // --- Share token balances / allowances ---
    Balance(Address),
    Allow(Address, Address),
    Supply,

    // --- User deposit tracking ---
    UDep(Address),

    // --- Total deposited principal ---
    TDep,

    // --- Early redemption ---
    RCount,
    RReq(u32),
    EShares(Address),

    // --- Blacklist ---
    BList(Address),

    // --- Transfer KYC gate ---
    TKyc,

    // --- Emergency pro-rata distribution ---
    EBal,
    EHclm(Address),
    ETSna,

    // --- Emergency multi-sig ---
    ESign,
    EThre,
    EPCount,
    EProp(u32),
    EPAppr(u32),
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
    let key = Key::Balance(addr.clone());
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
        Key::HasClm(addr.clone(), epoch),
        Key::UShares(addr.clone(), epoch),
        Key::USnap(addr.clone(), epoch),
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
        Key::YldClm(addr.clone()),
        Key::LInter(addr.clone()),
        Key::LastClm(addr.clone()),
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
            e.storage().instance().get(&Key::$key).unwrap()
        }
    };
}
macro_rules! instance_put {
    ($fn:ident, $key:ident, $ty:ty) => {
        pub fn $fn(e: &Env, val: $ty) {
            e.storage().instance().set(&Key::$key, &val);
        }
    };
}

// Share token metadata
instance_get!(get_share_name, ShName, String);
instance_put!(put_share_name, ShName, String);
instance_get!(get_share_symbol, ShSymb, String);
instance_put!(put_share_symbol, ShSymb, String);
instance_get!(get_share_decimals, ShDec, u32);
instance_put!(put_share_decimals, ShDec, u32);

// Asset
instance_get!(get_asset, Asset, Address);
instance_put!(put_asset, Asset, Address);

// Admin
instance_get!(get_admin, Admin, Address);
instance_put!(put_admin, Admin, Address);

// zkMe
instance_get!(get_zkme_verifier, Verifier, Address);
instance_put!(put_zkme_verifier, Verifier, Address);
instance_get!(get_cooperator, Coop, Address);
instance_put!(put_cooperator, Coop, Address);

// RWA
instance_get!(get_rwa_name, RwaName, String);
instance_put!(put_rwa_name, RwaName, String);
instance_get!(get_rwa_symbol, RwaSymb, String);
instance_put!(put_rwa_symbol, RwaSymb, String);
instance_get!(get_rwa_document_uri, RwaUri, String);
instance_put!(put_rwa_document_uri, RwaUri, String);
instance_get!(get_rwa_category, RwaCat, String);
instance_put!(put_rwa_category, RwaCat, String);
instance_get!(get_expected_apy, Apy, u32);
instance_put!(put_expected_apy, Apy, u32);

// Config
instance_get!(get_funding_target, Target, i128);
instance_put!(put_funding_target, Target, i128);
instance_get!(get_maturity_date, Maturity, u64);
instance_put!(put_maturity_date, Maturity, u64);

pub fn get_fund_deadline(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&Key::Deadline)
        .unwrap_or(0)
}
pub fn put_fund_deadline(e: &Env, val: u64) {
    e.storage().instance().set(&Key::Deadline, &val);
}

instance_get!(get_min_deposit, MinDep, i128);
instance_put!(put_min_deposit, MinDep, i128);
instance_get!(get_max_user_dep, MaxUser, i128);
instance_put!(put_max_user_dep, MaxUser, i128);
instance_get!(get_redem_fee_bps, RedemFee, u32);
instance_put!(put_redem_fee_bps, RedemFee, u32);

// State
instance_get!(get_vault_state, State, VaultState);
instance_put!(put_vault_state, State, VaultState);
instance_get!(get_paused, Paused, bool);
instance_put!(put_paused, Paused, bool);
instance_get!(get_freeze_flags, Flags, u32);
instance_put!(put_freeze_flags, Flags, u32);
instance_get!(get_locked, Locked, bool);
instance_put!(put_locked, Locked, bool);

pub fn get_activation_timestamp(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&Key::ActivateTime)
        .unwrap_or(0)
}
pub fn put_activation_timestamp(e: &Env, val: u64) {
    e.storage()
        .instance()
        .set(&Key::ActivateTime, &val);
}

// Epoch / yield (global)
instance_get!(get_current_epoch, Epoch, u32);
instance_put!(put_current_epoch, Epoch, u32);
instance_get!(get_total_yield_distributed, YieldDist, i128);
instance_put!(put_total_yield_distributed, YieldDist, i128);

// Supply
instance_get!(get_total_supply, Supply, i128);
instance_put!(put_total_supply, Supply, i128);

// TDep (principal tracking)
instance_get!(get_total_deposited, TDep, i128);
instance_put!(put_total_deposited, TDep, i128);

// RedemCount
instance_get!(get_redemption_counter, RedemCount, u32);
instance_put!(put_redemption_counter, RedemCount, u32);

// Versioning
instance_get!(get_contract_version, Ver, u32);
instance_put!(put_contract_version, Ver, u32);
instance_get!(get_storage_schema_version, SchemaVersion, u32);
instance_put!(put_storage_schema_version, SchemaVersion, u32);

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
        .get(&Key::Role(addr.clone(), role))
        .unwrap_or(false)
}

/// Grant (`val = true`) or revoke (`val = false`) `role` for `addr`.
pub fn put_role(e: &Env, addr: Address, role: Role, val: bool) {
    if val {
        e.storage()
            .instance()
            .set(&Key::Role(addr, role), &true);
    } else {
        e.storage().instance().remove(&Key::Role(addr, role));
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
        .get(&Key::EpYield(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_yield(e: &Env, epoch: u32, val: i128) {
    e.storage()
        .instance()
        .set(&Key::EpYield(epoch), &val);
}

pub fn get_epoch_total_shares(e: &Env, epoch: u32) -> i128 {
    e.storage()
        .instance()
        .get(&Key::EpShares(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_total_shares(e: &Env, epoch: u32, val: i128) {
    e.storage()
        .instance()
        .set(&Key::EpShares(epoch), &val);
}

pub fn get_epoch_timestamp(e: &Env, epoch: u32) -> u64 {
    e.storage()
        .instance()
        .get(&Key::EpTime(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_timestamp(e: &Env, epoch: u32, val: u64) {
    e.storage()
        .instance()
        .set(&Key::EpTime(epoch), &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Allow data type
// ─────────────────────────────────────────────────────────────────────────────

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
/// persistent entry TTL to match, enabling automatic ledger-level cleanup.
pub fn put_share_allowance_with_expiry(
    e: &Env,
    owner: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = Key::Allow(owner.clone(), spender.clone());
    e.storage().persistent().set(
        &key,
        &AllowData {
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
        .get(&Key::UDep(addr.clone()))
        .unwrap_or(0)
}
pub fn put_user_deposited(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&Key::UDep(addr.clone()), &val);
    e.storage().persistent().extend_ttl(
        &Key::UDep(addr.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_total_yield_claimed(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::YieldClaimed(addr.clone()))
        .unwrap_or(0)
}
pub fn put_total_yield_claimed(e: &Env, addr: &Address, val: i128) {
    let key = Key::YieldClaimed(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_last_claimed_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&Key::LastClaimed(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_claimed_epoch(e: &Env, addr: &Address, val: u32) {
    let key = Key::LastClaimed(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_has_claimed_epoch(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&Key::HasClaimed(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_claimed_epoch(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = Key::HasClaimed(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_user_shares_at_epoch(e: &Env, addr: &Address, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::UserShares(addr.clone(), epoch))
        .unwrap_or(0)
}
pub fn put_user_shares_at_epoch(e: &Env, addr: &Address, epoch: u32, val: i128) {
    let key = Key::UserShares(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_has_snapshot_for_epoch(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&Key::HasSnapshot(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_snapshot_for_epoch(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = Key::HasSnapshot(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_last_interaction_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&Key::LastInteract(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_interaction_epoch(e: &Env, addr: &Address, val: u32) {
    let key = Key::LastInteract(addr.clone());
    e.storage().persistent().set(&key, &val);
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
        .get(&Key::RedemReq(id))
        .unwrap_or_else(|| panic_with_error!(e, Error::InvalidRedemptionRequest))
}
pub fn put_redemption_request(e: &Env, id: u32, req: RedemRequest) {
    e.storage()
        .persistent()
        .set(&Key::RedemReq(id), &req);
    e.storage().persistent().extend_ttl(
        &Key::RedemReq(id),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_escrowed_shares(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::EscrowShares(addr.clone()))
        .unwrap_or(0)
}

pub fn put_escrowed_shares(e: &Env, addr: &Address, amount: i128) {
    let key = Key::EscrowShares(addr.clone());
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
        .get(&Key::TransferKyc)
        .unwrap_or(true)
}

pub fn put_transfer_requires_kyc(e: &Env, val: bool) {
    e.storage()
        .instance()
        .set(&Key::TransferKyc, &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blacklist (persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_blacklisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&Key::BList(addr.clone()))
        .unwrap_or(false)
}

pub fn put_blacklisted(e: &Env, addr: &Address, status: bool) {
    e.storage()
        .persistent()
        .set(&Key::BList(addr.clone()), &status);
    e.storage().persistent().extend_ttl(
        &Key::BList(addr.clone()),
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
        .get(&Key::EmergBalance)
        .unwrap_or(0)
}

pub fn put_emergency_balance(e: &Env, val: i128) {
    e.storage().instance().set(&Key::EmergBalance, &val);
}

pub fn get_emergency_total_supply_snapshot(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&Key::EmTotalSupSnap)
        .unwrap_or(0)
}

pub fn put_emergency_total_supply_snapshot(e: &Env, val: i128) {
    e.storage()
        .instance()
        .set(&Key::EmTotalSupSnap, &val);
}

pub fn get_has_claimed_emergency(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&Key::HasClaimEmerg(addr.clone()))
        .unwrap_or(false)
}

pub fn put_has_claimed_emergency(e: &Env, addr: &Address, val: bool) {
    let key = Key::HasClaimEmerg(addr.clone());
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
    e.storage().instance().has(&Key::EmSigners)
}

pub fn get_emergency_signers(e: &Env) -> Vec<Address> {
    e.storage()
        .instance()
        .get(&Key::EmSigners)
        .unwrap()
}

pub fn put_emergency_signers(e: &Env, signers: Vec<Address>) {
    e.storage()
        .instance()
        .set(&Key::EmSigners, &signers);
}

pub fn get_emergency_threshold(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&Key::EmThreshold)
        .unwrap_or(0)
}

pub fn put_emergency_threshold(e: &Env, threshold: u32) {
    e.storage()
        .instance()
        .set(&Key::EmThreshold, &threshold);
}

pub fn get_emergency_proposal_counter(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&Key::EmPropCount)
        .unwrap_or(0)
}

pub fn put_emergency_proposal_counter(e: &Env, val: u32) {
    e.storage()
        .instance()
        .set(&Key::EmPropCount, &val);
}

pub fn get_emergency_proposal(e: &Env, id: u32) -> Option<EProp> {
    e.storage()
        .persistent()
        .get(&Key::EmergProp(id))
}

pub fn put_emergency_proposal(e: &Env, id: u32, proposal: EProp) {
    let key = Key::EmergProp(id);
    e.storage().persistent().set(&key, &proposal);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_emerg_approvals(e: &Env, id: u32) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&Key::EPAppr(id))
        .unwrap_or_else(|| Vec::new(e))
}

pub fn put_emergency_proposal_approvals(e: &Env, id: u32, approvals: Vec<Address>) {
    let key = Key::EPAppr(id);
    e.storage().persistent().set(&key, &approvals);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}
