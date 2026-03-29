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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Key {
    // --- Share token metadata ---
    ShareName,
    ShrSymb,
    ShrDec,

    // --- Asset ---
    Asset,

    // --- Admin / operators ---
    Admin,
    /// Granular RBAC role assignment: (address, role) → bool.
    /// Replaces the old binary `Operator(Address)` key.
    Role(Address, Role),

    // --- zkMe ---
    ZkmeVer,
    Coop,

    // --- RWA details ---
    RwaName,
    RwaSymbol,
    RwaDocUri,
    RwaCat,
    ExpApy,

    // --- Vault config ---
    FundTgt,
    MatDate,
    MinDep,
    MaxDepUsr,
    ERedFee,
    /// Yield vesting period in seconds (0 = instant claiming for backward compatibility)
    YldVstPer,

    // --- Vault state ---
    VaultSt,
    Paused,
    FrzFlags,
    ActTimest,
    /// Reentrancy lock — true while a guarded function is executing.
    Locked,
    /// Unix timestamp deadline for funding; 0 means no deadline.
    FundDeadl,

    // --- Versioning ---
    CtrVers,
    StorSch,

    // --- Epoch / yield ---
    CurEpoch,
    TotYield,
    EpYield(u32),
    EpTotShr(u32),
    EpTimest(u32),
    TotYldClm(Address),
    HasClmEp(Address, u32),
    /// Cursor: the highest epoch at which all epochs ≤ cursor have been claimed.
    /// Allows pending_yield / claim_yield to scan only new epochs.
    LstClmEp(Address),
    /// Track how much yield a user has claimed for a specific epoch (for vesting)
    UsrEpYldClm(Address, u32),

    // --- User share snapshots ---
    UsrShrEp(Address, u32),
    HasSnEp(Address, u32),
    LstIntEp(Address),

    // --- Share token balances / allowances ---
    Balance(Address),
    Allowance(Address, Address), // (owner, spender)
    TotSup,

    // --- User deposit tracking ---
    UsrDep(Address),

    // --- Total deposited principal ---
    TotDep,

    // --- Early redemption ---
    RedCnt,
    RedReq(u32),
    EscShr(Address),

    // --- Blacklist ---
    Blacklst(Address),

    // --- Transfer KYC gate ---
    XferKyc,

    // --- Emergency pro-rata distribution ---
    EmgBal,
    HasClmEmg(Address),
    EmgTotSup,

    // --- Timelock ---
    TlkDelay,
    TlkCount,
    TlkAct(u32),
}

// Manual serialization for `Key`: unit variants use a bare `u32` tag; any key that
// carries an address, epoch, or role must encode as `(tag, …payload)` so entries
// do not collide (the previous `u32`-only encoding mapped every `Balance(_)` to
// the same key, etc.).
const K_TAG_ROLE: u32 = 200;
const K_TAG_EP_YIELD: u32 = 201;
const K_TAG_EP_TOT_SHR: u32 = 202;
const K_TAG_EP_TIMEST: u32 = 203;
const K_TAG_TOT_YLD_CLM: u32 = 204;
const K_TAG_HAS_CLM_EP: u32 = 205;
const K_TAG_LST_CLM_EP: u32 = 206;
const K_TAG_USR_EP_YLD_CLM: u32 = 207;
const K_TAG_USR_SHR_EP: u32 = 208;
const K_TAG_HAS_SN_EP: u32 = 209;
const K_TAG_LST_INT_EP: u32 = 210;
const K_TAG_BALANCE: u32 = 211;
const K_TAG_ALLOWANCE: u32 = 212;
const K_TAG_USR_DEP: u32 = 213;
const K_TAG_RED_REQ: u32 = 214;
const K_TAG_ESC_SHR: u32 = 215;
const K_TAG_BLACKLST: u32 = 216;
const K_TAG_HAS_CLM_EMG: u32 = 217;
const K_TAG_TLK_ACT: u32 = 218;

impl soroban_sdk::IntoVal<Env, soroban_sdk::Val> for Key {
    fn into_val(&self, env: &Env) -> soroban_sdk::Val {
        match self {
            Key::Role(a, r) => (K_TAG_ROLE, a.clone(), r.clone()).into_val(env),
            Key::EpYield(e) => (K_TAG_EP_YIELD, *e).into_val(env),
            Key::EpTotShr(e) => (K_TAG_EP_TOT_SHR, *e).into_val(env),
            Key::EpTimest(e) => (K_TAG_EP_TIMEST, *e).into_val(env),
            Key::TotYldClm(a) => (K_TAG_TOT_YLD_CLM, a.clone()).into_val(env),
            Key::HasClmEp(a, e) => (K_TAG_HAS_CLM_EP, a.clone(), *e).into_val(env),
            Key::LstClmEp(a) => (K_TAG_LST_CLM_EP, a.clone()).into_val(env),
            Key::UsrEpYldClm(a, e) => (K_TAG_USR_EP_YLD_CLM, a.clone(), *e).into_val(env),
            Key::UsrShrEp(a, e) => (K_TAG_USR_SHR_EP, a.clone(), *e).into_val(env),
            Key::HasSnEp(a, e) => (K_TAG_HAS_SN_EP, a.clone(), *e).into_val(env),
            Key::LstIntEp(a) => (K_TAG_LST_INT_EP, a.clone()).into_val(env),
            Key::Balance(a) => (K_TAG_BALANCE, a.clone()).into_val(env),
            Key::Allowance(o, s) => (K_TAG_ALLOWANCE, o.clone(), s.clone()).into_val(env),
            Key::UsrDep(a) => (K_TAG_USR_DEP, a.clone()).into_val(env),
            Key::RedReq(n) => (K_TAG_RED_REQ, *n).into_val(env),
            Key::EscShr(a) => (K_TAG_ESC_SHR, a.clone()).into_val(env),
            Key::Blacklst(a) => (K_TAG_BLACKLST, a.clone()).into_val(env),
            Key::HasClmEmg(a) => (K_TAG_HAS_CLM_EMG, a.clone()).into_val(env),
            Key::TlkAct(n) => (K_TAG_TLK_ACT, *n).into_val(env),

            Key::ShareName => 0u32.into_val(env),
            Key::ShrSymb => 1u32.into_val(env),
            Key::ShrDec => 2u32.into_val(env),
            Key::Asset => 3u32.into_val(env),
            Key::Admin => 4u32.into_val(env),
            Key::ZkmeVer => 6u32.into_val(env),
            Key::Coop => 7u32.into_val(env),
            Key::RwaName => 8u32.into_val(env),
            Key::RwaSymbol => 9u32.into_val(env),
            Key::RwaDocUri => 10u32.into_val(env),
            Key::RwaCat => 11u32.into_val(env),
            Key::ExpApy => 12u32.into_val(env),
            Key::FundTgt => 13u32.into_val(env),
            Key::MatDate => 14u32.into_val(env),
            Key::MinDep => 15u32.into_val(env),
            Key::MaxDepUsr => 16u32.into_val(env),
            Key::ERedFee => 17u32.into_val(env),
            Key::YldVstPer => 100u32.into_val(env),
            Key::VaultSt => 18u32.into_val(env),
            Key::Paused => 19u32.into_val(env),
            Key::FrzFlags => 20u32.into_val(env),
            Key::ActTimest => 21u32.into_val(env),
            Key::Locked => 22u32.into_val(env),
            Key::FundDeadl => 23u32.into_val(env),
            Key::CtrVers => 24u32.into_val(env),
            Key::StorSch => 25u32.into_val(env),
            Key::CurEpoch => 26u32.into_val(env),
            Key::TotYield => 27u32.into_val(env),
            Key::TotSup => 39u32.into_val(env),
            Key::TotDep => 41u32.into_val(env),
            Key::RedCnt => 42u32.into_val(env),
            Key::XferKyc => 46u32.into_val(env),
            Key::EmgBal => 47u32.into_val(env),
            Key::EmgTotSup => 49u32.into_val(env),
            Key::TlkDelay => 50u32.into_val(env),
            Key::TlkCount => 51u32.into_val(env),
        }
    }
}

impl soroban_sdk::TryFromVal<Env, soroban_sdk::Val> for Key {
    type Error = soroban_sdk::Error;
    fn try_from_val(env: &Env, val: &soroban_sdk::Val) -> Result<Self, Self::Error> {
        if let Ok((tag, a, r)) = <(u32, Address, Role)>::try_from_val(env, val) {
            if tag == K_TAG_ROLE {
                return Ok(Key::Role(a, r));
            }
        }
        if let Ok((tag, a, e)) = <(u32, Address, u32)>::try_from_val(env, val) {
            return Ok(match tag {
                K_TAG_HAS_CLM_EP => Key::HasClmEp(a, e),
                K_TAG_USR_EP_YLD_CLM => Key::UsrEpYldClm(a, e),
                K_TAG_USR_SHR_EP => Key::UsrShrEp(a, e),
                K_TAG_HAS_SN_EP => Key::HasSnEp(a, e),
                _ => return Err(soroban_sdk::Error::from_contract_error(1)),
            });
        }
        if let Ok((tag, a)) = <(u32, Address)>::try_from_val(env, val) {
            return Ok(match tag {
                K_TAG_TOT_YLD_CLM => Key::TotYldClm(a),
                K_TAG_LST_CLM_EP => Key::LstClmEp(a),
                K_TAG_LST_INT_EP => Key::LstIntEp(a),
                K_TAG_BALANCE => Key::Balance(a),
                K_TAG_USR_DEP => Key::UsrDep(a),
                K_TAG_ESC_SHR => Key::EscShr(a),
                K_TAG_BLACKLST => Key::Blacklst(a),
                K_TAG_HAS_CLM_EMG => Key::HasClmEmg(a),
                _ => return Err(soroban_sdk::Error::from_contract_error(1)),
            });
        }
        if let Ok((tag, o, s)) = <(u32, Address, Address)>::try_from_val(env, val) {
            if tag == K_TAG_ALLOWANCE {
                return Ok(Key::Allowance(o, s));
            }
        }
        if let Ok((tag, n)) = <(u32, u32)>::try_from_val(env, val) {
            return Ok(match tag {
                K_TAG_EP_YIELD => Key::EpYield(n),
                K_TAG_EP_TOT_SHR => Key::EpTotShr(n),
                K_TAG_EP_TIMEST => Key::EpTimest(n),
                K_TAG_RED_REQ => Key::RedReq(n),
                K_TAG_TLK_ACT => Key::TlkAct(n),
                _ => return Err(soroban_sdk::Error::from_contract_error(1)),
            });
        }
        let n = u32::try_from_val(env, val)?;
        match n {
            0 => Ok(Key::ShareName),
            1 => Ok(Key::ShrSymb),
            2 => Ok(Key::ShrDec),
            3 => Ok(Key::Asset),
            4 => Ok(Key::Admin),
            6 => Ok(Key::ZkmeVer),
            7 => Ok(Key::Coop),
            8 => Ok(Key::RwaName),
            9 => Ok(Key::RwaSymbol),
            10 => Ok(Key::RwaDocUri),
            11 => Ok(Key::RwaCat),
            12 => Ok(Key::ExpApy),
            13 => Ok(Key::FundTgt),
            14 => Ok(Key::MatDate),
            15 => Ok(Key::MinDep),
            16 => Ok(Key::MaxDepUsr),
            17 => Ok(Key::ERedFee),
            18 => Ok(Key::VaultSt),
            19 => Ok(Key::Paused),
            20 => Ok(Key::FrzFlags),
            21 => Ok(Key::ActTimest),
            22 => Ok(Key::Locked),
            23 => Ok(Key::FundDeadl),
            24 => Ok(Key::CtrVers),
            25 => Ok(Key::StorSch),
            26 => Ok(Key::CurEpoch),
            27 => Ok(Key::TotYield),
            39 => Ok(Key::TotSup),
            41 => Ok(Key::TotDep),
            42 => Ok(Key::RedCnt),
            46 => Ok(Key::XferKyc),
            47 => Ok(Key::EmgBal),
            49 => Ok(Key::EmgTotSup),
            50 => Ok(Key::TlkDelay),
            51 => Ok(Key::TlkCount),
            100 => Ok(Key::YldVstPer),
            _ => Err(soroban_sdk::Error::from_contract_error(1)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Separate key enum for multi-sig emergency (DataKey is at the 50-variant XDR
// limit, so new keys live here to avoid the LengthExceedsMax compile error).
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum EmergencyDataKey {
    /// Configured list of emergency signers.
    Signers,
    /// Required number of approvals to execute a proposal.
    Threshold,
    /// Proposal data keyed by proposal ID.
    Proposal(u32),
    /// Set of addresses that have approved a given proposal ID.
    Approvals(u32),
    /// Monotonically-increasing counter used to generate proposal IDs.
    Counter,
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

/// Extend the TTL for allowance entries to match balance lifetime thresholds.
/// Call this whenever allowance data is written or read to prevent silent archival.
pub fn bump_allowance(e: &Env, owner: &Address, spender: &Address) {
    let key = Key::Allowance(owner.clone(), spender.clone());
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
        Key::HasClmEp(addr.clone(), epoch),
        Key::UsrShrEp(addr.clone(), epoch),
        Key::HasSnEp(addr.clone(), epoch),
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
        Key::TotYldClm(addr.clone()),
        Key::LstIntEp(addr.clone()),
        Key::LstClmEp(addr.clone()),
        Key::UsrEpYldClm(addr.clone(), epoch), // Include the specific epoch key
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
instance_get!(get_share_name, ShareName, String);
instance_put!(put_share_name, ShareName, String);
instance_get!(get_share_symbol, ShrSymb, String);
instance_put!(put_share_symbol, ShrSymb, String);
instance_get!(get_share_decimals, ShrDec, u32);
instance_put!(put_share_decimals, ShrDec, u32);

// Asset
instance_get!(get_asset, Asset, Address);
instance_put!(put_asset, Asset, Address);

// Admin
instance_get!(get_admin, Admin, Address);
instance_put!(put_admin, Admin, Address);

// zkMe
instance_get!(get_zkme_verifier, ZkmeVer, Address);
instance_put!(put_zkme_verifier, ZkmeVer, Address);
instance_get!(get_cooperator, Coop, Address);
instance_put!(put_cooperator, Coop, Address);

// RWA
instance_get!(get_rwa_name, RwaName, String);
instance_put!(put_rwa_name, RwaName, String);
instance_get!(get_rwa_symbol, RwaSymbol, String);
instance_put!(put_rwa_symbol, RwaSymbol, String);
instance_get!(get_rwa_document_uri, RwaDocUri, String);
instance_put!(put_rwa_document_uri, RwaDocUri, String);
instance_get!(get_rwa_category, RwaCat, String);
instance_put!(put_rwa_category, RwaCat, String);
instance_get!(get_expected_apy, ExpApy, u32);
instance_put!(put_expected_apy, ExpApy, u32);

// Config
instance_get!(get_funding_target, FundTgt, i128);
instance_put!(put_funding_target, FundTgt, i128);
instance_get!(get_maturity_date, MatDate, u64);
instance_put!(put_maturity_date, MatDate, u64);

pub fn get_funding_deadline(e: &Env) -> u64 {
    e.storage().instance().get(&Key::FundDeadl).unwrap_or(0)
}
pub fn put_funding_deadline(e: &Env, val: u64) {
    e.storage().instance().set(&Key::FundDeadl, &val);
}

instance_get!(get_min_deposit, MinDep, i128);
instance_put!(put_min_deposit, MinDep, i128);
instance_get!(get_max_deposit_per_user, MaxDepUsr, i128);
instance_put!(put_max_deposit_per_user, MaxDepUsr, i128);
instance_get!(get_early_redemption_fee_bps, ERedFee, u32);
instance_put!(put_early_redemption_fee_bps, ERedFee, u32);

pub fn get_yield_vesting_period(e: &Env) -> u64 {
    e.storage().instance().get(&Key::YldVstPer).unwrap_or(0) // Default to 0 for backward compatibility (instant claiming)
}
pub fn put_yield_vesting_period(e: &Env, val: u64) {
    e.storage().instance().set(&Key::YldVstPer, &val);
}

// State
instance_get!(get_vault_state, VaultSt, VaultState);
instance_put!(put_vault_state, VaultSt, VaultState);
instance_get!(get_paused, Paused, bool);
instance_put!(put_paused, Paused, bool);
instance_get!(get_freeze_flags, FrzFlags, u32);
instance_put!(put_freeze_flags, FrzFlags, u32);
instance_get!(get_locked, Locked, bool);
instance_put!(put_locked, Locked, bool);

pub fn get_activation_timestamp(e: &Env) -> u64 {
    e.storage().instance().get(&Key::ActTimest).unwrap_or(0)
}
pub fn put_activation_timestamp(e: &Env, val: u64) {
    e.storage().instance().set(&Key::ActTimest, &val);
}

// Epoch / yield (global)
instance_get!(get_current_epoch, CurEpoch, u32);
instance_put!(put_current_epoch, CurEpoch, u32);
instance_get!(get_total_yield_distributed, TotYield, i128);
instance_put!(put_total_yield_distributed, TotYield, i128);

// TotalSupply
instance_get!(get_total_supply, TotSup, i128);
instance_put!(put_total_supply, TotSup, i128);

// TotalDeposited (principal tracking)
instance_get!(get_total_deposited, TotDep, i128);
instance_put!(put_total_deposited, TotDep, i128);

// RedemptionCounter
instance_get!(get_redemption_counter, RedCnt, u32);
instance_put!(put_redemption_counter, RedCnt, u32);

// Versioning
instance_get!(get_contract_version, CtrVers, u32);
instance_put!(put_contract_version, CtrVers, u32);
instance_get!(get_storage_schema_version, StorSch, u32);
instance_put!(put_storage_schema_version, StorSch, u32);

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
        e.storage().instance().set(&Key::Role(addr, role), &true);
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
    e.storage().instance().set(&Key::EpYield(epoch), &val);
}

pub fn get_epoch_total_shares(e: &Env, epoch: u32) -> i128 {
    e.storage()
        .instance()
        .get(&Key::EpTotShr(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_total_shares(e: &Env, epoch: u32, val: i128) {
    e.storage().instance().set(&Key::EpTotShr(epoch), &val);
}

pub fn get_epoch_timestamp(e: &Env, epoch: u32) -> u64 {
    e.storage()
        .instance()
        .get(&Key::EpTimest(epoch))
        .unwrap_or(0)
}
pub fn put_epoch_timestamp(e: &Env, epoch: u32, val: u64) {
    e.storage().instance().set(&Key::EpTimest(epoch), &val);
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
///
/// # TTL Management
/// This function implements bump-on-read behavior: if an allowance entry exists
/// (regardless of expiration), its TTL is extended to prevent silent archival.
/// This ensures that active allowances remain available and don't unexpectedly
/// return 0 due to storage archival.
pub fn get_share_allowance(e: &Env, owner: &Address, spender: &Address) -> i128 {
    let key = Key::Allowance(owner.clone(), spender.clone());
    match e.storage().persistent().get::<_, AllowanceData>(&key) {
        Some(data) => {
            // Bump TTL on read to prevent silent archival of active allowances
            bump_allowance(e, owner, spender);

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
///
/// # TTL Management
/// Uses standard BALANCE_LIFETIME_THRESHOLD/BALANCE_BUMP_AMOUNT to prevent
/// silent archival, consistent with other persistent user data.
pub fn put_share_allowance(e: &Env, owner: &Address, spender: &Address, new_amount: i128) {
    let key = Key::Allowance(owner.clone(), spender.clone());
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
    // Use standard TTL bumping to prevent silent archival
    bump_allowance(e, owner, spender);
}

/// Stores a fresh allowance with an on-chain `expiration_ledger` and sets the
/// persistent entry TTL to match, enabling automatic ledger-level cleanup.
///
/// # TTL Management
/// Uses standard BALANCE_LIFETIME_THRESHOLD/BALANCE_BUMP_AMOUNT to prevent
/// silent archival, while still respecting the expiration_ledger for business logic.
pub fn put_share_allowance_with_expiry(
    e: &Env,
    owner: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = Key::Allowance(owner.clone(), spender.clone());
    e.storage().persistent().set(
        &key,
        &AllowanceData {
            amount,
            expiration_ledger,
        },
    );
    // Use standard TTL bumping to prevent silent archival
    bump_allowance(e, owner, spender);
}

pub fn get_user_deposited(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::UsrDep(addr.clone()))
        .unwrap_or(0)
}
pub fn put_user_deposited(e: &Env, addr: &Address, val: i128) {
    e.storage()
        .persistent()
        .set(&Key::UsrDep(addr.clone()), &val);
    e.storage().persistent().extend_ttl(
        &Key::UsrDep(addr.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_total_yield_claimed(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::TotYldClm(addr.clone()))
        .unwrap_or(0)
}
pub fn put_total_yield_claimed(e: &Env, addr: &Address, val: i128) {
    let key = Key::TotYldClm(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_user_epoch_yield_claimed(e: &Env, addr: &Address, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::UsrEpYldClm(addr.clone(), epoch))
        .unwrap_or(0)
}
pub fn put_user_epoch_yield_claimed(e: &Env, addr: &Address, epoch: u32, val: i128) {
    let key = Key::UsrEpYldClm(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_last_claimed_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&Key::LstClmEp(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_claimed_epoch(e: &Env, addr: &Address, val: u32) {
    let key = Key::LstClmEp(addr.clone());
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_has_claimed_epoch(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&Key::HasClmEp(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_claimed_epoch(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = Key::HasClmEp(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_user_shares_at_epoch(e: &Env, addr: &Address, epoch: u32) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::UsrShrEp(addr.clone(), epoch))
        .unwrap_or(0)
}
pub fn put_user_shares_at_epoch(e: &Env, addr: &Address, epoch: u32, val: i128) {
    let key = Key::UsrShrEp(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_has_snapshot_for_epoch(e: &Env, addr: &Address, epoch: u32) -> bool {
    e.storage()
        .persistent()
        .get(&Key::HasSnEp(addr.clone(), epoch))
        .unwrap_or(false)
}
pub fn put_has_snapshot_for_epoch(e: &Env, addr: &Address, epoch: u32, val: bool) {
    let key = Key::HasSnEp(addr.clone(), epoch);
    e.storage().persistent().set(&key, &val);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_last_interaction_epoch(e: &Env, addr: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&Key::LstIntEp(addr.clone()))
        .unwrap_or(0)
}
pub fn put_last_interaction_epoch(e: &Env, addr: &Address, val: u32) {
    let key = Key::LstIntEp(addr.clone());
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
        .get(&Key::RedReq(id))
        .unwrap_or_else(|| panic_with_error!(e, Error::InvalidRedemptionRequest))
}
pub fn put_redemption_request(e: &Env, id: u32, req: RedemptionRequest) {
    e.storage().persistent().set(&Key::RedReq(id), &req);
    e.storage().persistent().extend_ttl(
        &Key::RedReq(id),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

pub fn get_escrowed_shares(e: &Env, addr: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::EscShr(addr.clone()))
        .unwrap_or(0)
}

pub fn put_escrowed_shares(e: &Env, addr: &Address, amount: i128) {
    let key = Key::EscShr(addr.clone());
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
    e.storage().instance().get(&Key::XferKyc).unwrap_or(true)
}

pub fn put_transfer_requires_kyc(e: &Env, val: bool) {
    e.storage().instance().set(&Key::XferKyc, &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blacklist (persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_blacklisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&Key::Blacklst(addr.clone()))
        .unwrap_or(false)
}

pub fn put_blacklisted(e: &Env, addr: &Address, status: bool) {
    e.storage()
        .persistent()
        .set(&Key::Blacklst(addr.clone()), &status);
    e.storage().persistent().extend_ttl(
        &Key::Blacklst(addr.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Emergency pro-rata distribution (instance + persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_emergency_balance(e: &Env) -> i128 {
    e.storage().instance().get(&Key::EmgBal).unwrap_or(0)
}

pub fn put_emergency_balance(e: &Env, val: i128) {
    e.storage().instance().set(&Key::EmgBal, &val);
}

pub fn get_emergency_total_supply_snapshot(e: &Env) -> i128 {
    e.storage().instance().get(&Key::EmgTotSup).unwrap_or(0)
}

pub fn put_emergency_total_supply_snapshot(e: &Env, val: i128) {
    e.storage().instance().set(&Key::EmgTotSup, &val);
}

pub fn get_has_claimed_emergency(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&Key::HasClmEmg(addr.clone()))
        .unwrap_or(false)
}

pub fn put_has_claimed_emergency(e: &Env, addr: &Address) {
    let key = Key::HasClmEmg(addr.clone());
    e.storage().persistent().set(&key, &true);
    bump_balance(e, addr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timelock storage functions
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_timelock_delay(e: &Env) -> u64 {
    e.storage().instance().get(&Key::TlkDelay).unwrap_or(172800) // Default: 48 hours
}

pub fn put_timelock_delay(e: &Env, delay: u64) {
    e.storage().instance().set(&Key::TlkDelay, &delay);
}

pub fn get_timelock_counter(e: &Env) -> u32 {
    e.storage().instance().get(&Key::TlkCount).unwrap_or(0)
}

pub fn put_timelock_counter(e: &Env, counter: u32) {
    e.storage().instance().set(&Key::TlkCount, &counter);
}

pub fn get_timelock_action(e: &Env, action_id: u32) -> Option<crate::types::TimelockAction> {
    e.storage().instance().get(&Key::TlkAct(action_id))
}

pub fn put_timelock_action(e: &Env, action_id: u32, action: crate::types::TimelockAction) {
    e.storage().instance().set(&Key::TlkAct(action_id), &action);
}

#[allow(dead_code)]
pub fn has_timelock_action(e: &Env, action_id: u32) -> bool {
    e.storage().instance().has(&Key::TlkAct(action_id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-sig emergency storage helpers
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_emergency_signers(e: &Env) -> Option<Vec<Address>> {
    e.storage().instance().get(&EmergencyDataKey::Signers)
}

pub fn put_emergency_signers(e: &Env, signers: Vec<Address>) {
    e.storage()
        .instance()
        .set(&EmergencyDataKey::Signers, &signers);
}

pub fn remove_emergency_signers(e: &Env) {
    e.storage().instance().remove(&EmergencyDataKey::Signers);
}

pub fn get_emergency_threshold(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&EmergencyDataKey::Threshold)
        .unwrap_or(0)
}

pub fn put_emergency_threshold(e: &Env, threshold: u32) {
    e.storage()
        .instance()
        .set(&EmergencyDataKey::Threshold, &threshold);
}

pub fn remove_emergency_threshold(e: &Env) {
    e.storage().instance().remove(&EmergencyDataKey::Threshold);
}

pub fn get_emergency_proposal_counter(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&EmergencyDataKey::Counter)
        .unwrap_or(0)
}

pub fn increment_emergency_proposal_counter(e: &Env) -> u32 {
    let next = get_emergency_proposal_counter(e) + 1;
    e.storage()
        .instance()
        .set(&EmergencyDataKey::Counter, &next);
    next
}

pub fn get_emergency_proposal(e: &Env, id: u32) -> Option<crate::types::EmergencyProposal> {
    e.storage()
        .persistent()
        .get(&EmergencyDataKey::Proposal(id))
}

pub fn put_emergency_proposal(e: &Env, id: u32, proposal: crate::types::EmergencyProposal) {
    let key = EmergencyDataKey::Proposal(id);
    e.storage().persistent().set(&key, &proposal);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

pub fn get_emergency_proposal_approvals(e: &Env, id: u32) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&EmergencyDataKey::Approvals(id))
        .unwrap_or_else(|| Vec::new(e))
}

pub fn put_emergency_proposal_approvals(e: &Env, id: u32, approvals: Vec<Address>) {
    let key = EmergencyDataKey::Approvals(id);
    e.storage().persistent().set(&key, &approvals);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}
