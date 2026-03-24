//! Soroban events for SingleRWA_Vault.
//!
//! Each function mirrors an EVM event from ISingleRWA_Vault.sol.

use soroban_sdk::{symbol_short, Address, Env, String};

use crate::types::VaultState;

pub fn emit_zkme_verifier_updated(e: &Env, old: Address, new: Address) {
    e.events().publish(
        (symbol_short!("zkme_upd"),),
        (old, new),
    );
}

pub fn emit_cooperator_updated(e: &Env, old: Address, new: Address) {
    e.events().publish(
        (symbol_short!("coop_upd"),),
        (old, new),
    );
}

pub fn emit_yield_distributed(e: &Env, epoch: u32, amount: i128, timestamp: u64) {
    e.events().publish(
        (symbol_short!("yield_dis"), epoch),
        (amount, timestamp),
    );
}

pub fn emit_yield_claimed(e: &Env, user: Address, amount: i128, epoch: u32) {
    e.events().publish(
        (symbol_short!("yield_clm"), user),
        (amount, epoch),
    );
}

pub fn emit_vault_state_changed(e: &Env, old: VaultState, new: VaultState) {
    e.events().publish(
        (symbol_short!("st_chg"),),
        (old, new),
    );
}

pub fn emit_maturity_date_set(e: &Env, timestamp: u64) {
    e.events().publish(
        (symbol_short!("mat_set"),),
        timestamp,
    );
}

pub fn emit_deposit_limits_updated(e: &Env, min: i128, max: i128) {
    e.events().publish(
        (symbol_short!("dep_lim"),),
        (min, max),
    );
}

pub fn emit_operator_updated(e: &Env, operator: Address, status: bool) {
    e.events().publish(
        (symbol_short!("op_upd"), operator),
        status,
    );
}

pub fn emit_emergency_action(e: &Env, paused: bool, reason: String) {
    e.events().publish(
        (symbol_short!("emergency"),),
        (paused, reason),
    );
}

// SEP-41 events
pub fn emit_approval(
    e: &Env,
    from: Address,
    spender: Address,
    amount: i128,
    expiration_ledger: u32,
) {
    e.events().publish(
        (symbol_short!("approve"), from, spender),
        (amount, expiration_ledger),
    );
}

pub fn emit_transfer(e: &Env, from: Address, to: Address, amount: i128) {
    e.events().publish(
        (symbol_short!("transfer"), from, to),
        amount,
    );
}

pub fn emit_burn(e: &Env, from: Address, amount: i128) {
    e.events().publish(
        (symbol_short!("burn"), from),
        amount,
    );
}

// ERC-4626 vault events

/// Emitted by `deposit` and `mint`.
/// Mirrors ERC-4626 `Deposit(caller, owner, assets, shares)`.
pub fn emit_deposit(
    e: &Env,
    caller: Address,
    receiver: Address,
    assets: i128,
    shares: i128,
) {
    e.events().publish(
        (symbol_short!("deposit"), caller, receiver),
        (assets, shares),
    );
}

/// Emitted by `withdraw` and `redeem`.
/// Mirrors ERC-4626 `Withdraw(caller, receiver, owner, assets, shares)`.
pub fn emit_withdraw(
    e: &Env,
    caller: Address,
    receiver: Address,
    owner: Address,
    assets: i128,
    shares: i128,
) {
    e.events().publish(
        (symbol_short!("withdraw"), caller, receiver, owner),
        (assets, shares),
    );
}

/// Emitted by `redeem_at_maturity` — includes auto-claimed yield.
pub fn emit_redeem_at_maturity(
    e: &Env,
    owner: Address,
    receiver: Address,
    shares: i128,
    assets: i128,
    yield_claimed: i128,
) {
    e.events().publish(
        (symbol_short!("mat_redm"), owner, receiver),
        (shares, assets, yield_claimed),
    );
}

/// Emitted by `request_early_redemption`.
pub fn emit_early_redemption_requested(
    e: &Env,
    user: Address,
    request_id: u32,
    shares: i128,
) {
    e.events().publish(
        (symbol_short!("erq_req"), user),
        (request_id, shares),
    );
}

/// Emitted by `process_early_redemption`.
pub fn emit_early_redemption_processed(
    e: &Env,
    user: Address,
    request_id: u32,
    net_assets: i128,
) {
    e.events().publish(
        (symbol_short!("erq_done"), user),
        (request_id, net_assets),
    );
}

/// Emitted by `transfer_admin`.
pub fn emit_admin_transferred(e: &Env, old_admin: Address, new_admin: Address) {
    e.events().publish(
        (symbol_short!("adm_xfr"),),
        (old_admin, new_admin),
    );
}

/// Emitted by `set_early_redemption_fee`.
pub fn emit_early_redemption_fee_set(e: &Env, fee_bps: u32) {
    e.events().publish(
        (symbol_short!("fee_set"),),
        fee_bps,
    );
}

/// Emitted by `set_funding_target`.
pub fn emit_funding_target_set(e: &Env, target: i128) {
    e.events().publish(
        (symbol_short!("fund_set"),),
        target,
    );
}

/// Emitted by `set_blacklisted`.
pub fn emit_address_blacklisted(e: &Env, address: Address, status: bool) {
    e.events().publish(
        (symbol_short!("blacklist"), address),
        status,
    );
}

/// Emitted by `cancel_funding` — vault moved to Cancelled state.
pub fn emit_funding_cancelled(e: &Env) {
    e.events().publish(
        (symbol_short!("fund_cxl"),),
        e.ledger().timestamp(),
    );
}

/// Emitted by `refund` — user burned shares and received deposited assets back.
pub fn emit_refunded(e: &Env, user: Address, amount: i128) {
    e.events().publish(
        (symbol_short!("refunded"), user),
        amount,
    );
}
