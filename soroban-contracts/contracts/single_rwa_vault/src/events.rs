//! Soroban events for SingleRWA_Vault.
//!
//! Each function mirrors an EVM event from ISingleRWA_Vault.sol.

use soroban_sdk::{symbol_short, Address, Env, String};

use crate::types::{Role, VaultState};

pub fn emit_zkme_verifier_updated(e: &Env, old: Address, new: Address) {
    e.events().publish((symbol_short!("zkme_upd"),), (old, new));
}

pub fn emit_cooperator_updated(e: &Env, old: Address, new: Address) {
    e.events().publish((symbol_short!("coop_upd"),), (old, new));
}

pub fn emit_yield_distributed(e: &Env, epoch: u32, amount: i128, timestamp: u64) {
    e.events()
        .publish((symbol_short!("yield_dis"), epoch), (amount, timestamp));
}

pub fn emit_yield_claimed(e: &Env, user: Address, amount: i128, epoch: u32) {
    e.events()
        .publish((symbol_short!("yield_clm"), user), (amount, epoch));
}

pub fn emit_vault_state_changed(e: &Env, old: VaultState, new: VaultState) {
    e.events().publish((symbol_short!("st_chg"),), (old, new));
}

pub fn emit_maturity_date_set(e: &Env, timestamp: u64) {
    e.events().publish((symbol_short!("mat_set"),), timestamp);
}

pub fn emit_deposit_limits_updated(e: &Env, min: i128, max: i128) {
    e.events().publish((symbol_short!("dep_lim"),), (min, max));
}

pub fn emit_operator_updated(e: &Env, operator: Address, status: bool) {
    e.events()
        .publish((symbol_short!("op_upd"), operator), status);
}

/// Emitted when the admin grants a role to an address.
pub fn emit_role_granted(e: &Env, addr: Address, role: Role) {
    e.events().publish((symbol_short!("role_grt"), addr), role);
}

/// Emitted when the admin revokes a role from an address.
pub fn emit_role_revoked(e: &Env, addr: Address, role: Role) {
    e.events().publish((symbol_short!("role_rvk"), addr), role);
}

/// Emitted when max investors limit is updated
pub fn emit_max_investors_updated(e: &Env, max_investors: u32) {
    e.events().publish((symbol_short!("max_inv_upd"),), max_investors);
}

/// Emitted when lock-up period is updated
pub fn emit_lock_up_period_updated(e: &Env, lock_up_period: u64) {
    e.events().publish((symbol_short!("lock_upd"),), lock_up_period);
}

pub fn emit_emergency_action(e: &Env, paused: bool, reason: String) {
    e.events()
        .publish((symbol_short!("emergency"),), (paused, reason));
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
    e.events()
        .publish((symbol_short!("transfer"), from, to), amount);
}

pub fn emit_burn(e: &Env, from: Address, amount: i128) {
    e.events().publish((symbol_short!("burn"), from), amount);
}

// ERC-4626 vault events

/// Emitted by `deposit` and `mint`.
/// Mirrors ERC-4626 `Deposit(caller, owner, assets, shares)`.
pub fn emit_deposit(e: &Env, caller: Address, receiver: Address, assets: i128, shares: i128) {
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

/// Which early-redemption user event to emit (same topics/data layout for all variants).
#[derive(Copy, Clone)]
enum EarlyRedemptionUserEventKind {
    Requested,
    Processed,
    Cancelled,
}

/// Common early-redemption event layout: topics `(tag, user)`, data `(request_id, amount)`.
///
/// Each `symbol_short!` lives in a `match` arm so topic symbols stay compile-time literals
/// (a single `publish` with a `Symbol` parameter is rejected by the Soroban host).
fn publish_early_redemption_user_event(
    e: &Env,
    kind: EarlyRedemptionUserEventKind,
    user: Address,
    request_id: u32,
    amount: i128,
) {
    match kind {
        EarlyRedemptionUserEventKind::Requested => {
            e.events()
                .publish((symbol_short!("erq_req"), user), (request_id, amount));
        }
        EarlyRedemptionUserEventKind::Processed => {
            e.events()
                .publish((symbol_short!("erq_done"), user), (request_id, amount));
        }
        EarlyRedemptionUserEventKind::Cancelled => {
            e.events()
                .publish((symbol_short!("erq_can"), user), (request_id, amount));
        }
    }
}

/// Emitted by `request_early_redemption`.
pub fn emit_early_redemption_requested(e: &Env, user: Address, request_id: u32, shares: i128) {
    publish_early_redemption_user_event(
        e,
        EarlyRedemptionUserEventKind::Requested,
        user,
        request_id,
        shares,
    );
}

/// Emitted by `process_early_redemption`.
pub fn emit_early_redemption_processed(e: &Env, user: Address, request_id: u32, net_assets: i128) {
    publish_early_redemption_user_event(
        e,
        EarlyRedemptionUserEventKind::Processed,
        user,
        request_id,
        net_assets,
    );
}

/// Emitted by `cancel_early_redemption`.
pub fn emit_early_redemption_cancelled(e: &Env, user: Address, request_id: u32, shares: i128) {
    publish_early_redemption_user_event(
        e,
        EarlyRedemptionUserEventKind::Cancelled,
        user,
        request_id,
        shares,
    );
}

/// Emitted by `transfer_admin`.
#[allow(dead_code)]
pub fn emit_admin_transferred(e: &Env, old_admin: Address, new_admin: Address) {
    e.events()
        .publish((symbol_short!("adm_xfr"),), (old_admin, new_admin));
}

/// Emitted by `set_rwa_details`, `set_rwa_document_uri`, or `set_expected_apy`.
pub fn emit_rwa_details_updated(
    e: &Env,
    name: String,
    symbol: String,
    document_uri: String,
    category: String,
    expected_apy: u32,
) {
    e.events().publish(
        (symbol_short!("rwa_upd"),),
        (name, symbol, document_uri, category, expected_apy),
    );
}

/// Emitted by `set_early_redemption_fee`.
pub fn emit_early_redemption_fee_set(e: &Env, fee_bps: u32) {
    e.events().publish((symbol_short!("fee_set"),), fee_bps);
}

pub fn emit_yield_vesting_period_set(e: &Env, vesting_period: u64) {
    e.events()
        .publish((symbol_short!("vest_set"),), vesting_period);
}

/// Emitted by `set_funding_target`.
pub fn emit_funding_target_set(e: &Env, target: i128) {
    e.events().publish((symbol_short!("fund_set"),), target);
}

/// Emitted by `set_blacklisted`.
pub fn emit_address_blacklisted(e: &Env, address: Address, status: bool) {
    e.events()
        .publish((symbol_short!("blacklist"), address), status);
}

/// Emitted by `cancel_funding` — vault moved to Cancelled state.
pub fn emit_funding_cancelled(e: &Env) {
    e.events()
        .publish((symbol_short!("fund_cxl"),), e.ledger().timestamp());
}

/// Emitted by `refund` — user burned shares and received deposited assets back.
pub fn emit_refunded(e: &Env, user: Address, amount: i128) {
    e.events()
        .publish((symbol_short!("refunded"), user), amount);
}

/// Emitted by `emergency_enable_pro_rata` — vault enters Emergency state.
pub fn emit_emergency_mode_enabled(e: &Env, balance: i128, total_supply: i128) {
    e.events()
        .publish((symbol_short!("emerg_on"),), (balance, total_supply));
}

/// Emitted by `emergency_claim` — user claimed their pro-rata share.
pub fn emit_emergency_claimed(e: &Env, user: Address, amount: i128) {
    e.events()
        .publish((symbol_short!("emerg_clm"), user), amount);
}

/// Emitted by `migrate` — storage schema upgraded.
pub fn emit_data_migrated(e: &Env, old_version: u32, new_version: u32) {
    e.events()
        .publish((symbol_short!("data_mig"), old_version, new_version), ());
}

// ─────────────────────────────────────────────────────────────────────────────
// Timelock events
// ─────────────────────────────────────────────────────────────────────────────

/// Emitted when a timelock action is proposed.
pub fn emit_action_proposed(
    e: &Env,
    action_id: u32,
    action_type: crate::types::ActionType,
    executable_at: u64,
) {
    e.events().publish(
        (symbol_short!("act_prp"), action_id),
        (action_type, executable_at),
    );
}

/// Emitted when a timelock action is executed.
#[allow(dead_code)]
pub fn emit_action_executed(e: &Env, action_id: u32, action_type: crate::types::ActionType) {
    e.events()
        .publish((symbol_short!("act_exec"), action_id), action_type);
}

/// Emitted when a timelock action is cancelled.
pub fn emit_action_cancelled(e: &Env, action_id: u32, action_type: crate::types::ActionType) {
    e.events()
        .publish((symbol_short!("act_canc"), action_id), action_type);
}

/// Emitted by `propose_emergency_withdraw` — a new multi-sig proposal was created.
pub fn emit_emergency_proposed(e: &Env, proposal_id: u32, proposer: Address, recipient: Address) {
    e.events().publish(
        (symbol_short!("emg_prop"), proposal_id),
        (proposer, recipient),
    );
}

/// Emitted by `approve_emergency_withdraw` — a signer approved a proposal.
pub fn emit_emergency_approved(e: &Env, proposal_id: u32, approver: Address, approval_count: u32) {
    e.events().publish(
        (symbol_short!("emg_appr"), proposal_id),
        (approver, approval_count),
    );
}

/// Emitted by `execute_emergency_withdraw` — the multi-sig withdrawal was executed.
pub fn emit_emergency_executed(e: &Env, proposal_id: u32, recipient: Address, amount: i128) {
    e.events().publish(
        (symbol_short!("emg_exec"), proposal_id),
        (recipient, amount),
    );
}
