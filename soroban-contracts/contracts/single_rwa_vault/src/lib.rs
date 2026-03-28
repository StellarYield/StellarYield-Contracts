#![no_std]

mod errors;
mod events;
mod math;
mod migrations;
mod storage;
mod token_interface;
mod types;

#[cfg(test)]
mod fuzz_tests;
#[cfg(test)]
mod test_access_control;
#[cfg(test)]
mod test_burn_snapshot;
#[cfg(test)]
mod test_burn_yield_accounting;
#[cfg(test)]
mod test_claim_cursor;
#[cfg(test)]
mod test_close_vault;
#[cfg(test)]
mod test_constructor;
#[cfg(test)]
mod test_constructor_validation;
#[cfg(test)]
mod test_convert_erc4626;
#[cfg(test)]
mod test_deposit_limits;
#[cfg(test)]
mod test_epoch_history;
#[cfg(test)]
mod test_escrow;
#[cfg(test)]
mod test_freeze_flags;
#[cfg(test)]
mod test_funding_deadline;
#[cfg(test)]
mod test_helpers;
#[cfg(test)]
mod test_lifecycle;
#[cfg(test)]
mod test_multisig_emergency;
#[cfg(test)]
mod test_overflow;
#[cfg(test)]
mod test_rbac;
#[cfg(test)]
mod test_redemption;
#[cfg(test)]
mod test_rwa_setters;
#[cfg(test)]
mod test_token;
#[cfg(test)]
mod test_vault_state_guards;
#[cfg(test)]
mod test_withdraw;
#[cfg(test)]
mod tests;

pub use crate::types::*;

use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, Env, String, Vec};

use crate::errors::Error;
use crate::events::*;
use crate::migrations::CURRENT_SCHEMA_VERSION;
use crate::storage::*;
use crate::token_interface::*;

// ─────────────────────────────────────────────────────────────────────────────
// Contract struct
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct SingleRWAVault;

/// Fixed-point precision for yield_per_share calculations (10^6).
const PRECISION: i128 = 1_000_000;

#[contractimpl]
impl SingleRWAVault {
    pub const FREEZE_DEPOSIT_MINT: u32 = 1;
    pub const FREEZE_WITHDRAW_REDEEM: u32 = 2;
    pub const FREEZE_YIELD: u32 = 4;
    pub const FREEZE_ALL: u32 =
        Self::FREEZE_DEPOSIT_MINT | Self::FREEZE_WITHDRAW_REDEEM | Self::FREEZE_YIELD;

    /// Timeout for emergency proposals: 24 hours in seconds.
    pub const EMERGENCY_PROPOSAL_TIMEOUT: u64 = 86400;

    // ─────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────

    /// Initialise a new Single-RWA Vault.
    ///
    /// Parameters are grouped into an `InitParams` struct because Soroban
    /// enforces a maximum of 10 arguments per contract function.
    pub fn __constructor(e: &Env, params: InitParams) {
        // --- Validation ---
        if params.share_decimals > 18 {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.maturity_date <= e.ledger().timestamp() {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.early_redemption_fee_bps > 1000 {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.min_deposit < 0 || params.funding_target < 0 {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.min_deposit > 0
            && params.max_deposit_per_user > 0
            && params.max_deposit_per_user < params.min_deposit
        {
            panic_with_error!(e, Error::InvalidInitParams);
        }

        // --- Effects ---
        // Share token metadata (SEP-41 compatible storage)
        put_share_name(e, params.share_name);
        put_share_symbol(e, params.share_symbol);
        put_share_decimals(e, params.share_decimals);

        // Asset
        put_asset(e, params.asset);

        // Admin & access control
        put_admin(e, params.admin.clone());
        put_operator(e, params.admin.clone(), true);

        // zkMe KYC
        put_zkme_verifier(e, params.zkme_verifier);
        put_cooperator(e, params.cooperator);

        // RWA details
        put_rwa_name(e, params.rwa_name);
        put_rwa_symbol(e, params.rwa_symbol);
        put_rwa_document_uri(e, params.rwa_document_uri);
        put_rwa_category(e, params.rwa_category);
        put_expected_apy(e, params.expected_apy);

        // Vault configuration
        put_funding_target(e, params.funding_target);
        put_maturity_date(e, params.maturity_date);
        put_funding_deadline(e, params.funding_deadline);
        put_min_deposit(e, params.min_deposit);
        put_max_deposit_per_user(e, params.max_deposit_per_user);
        put_early_redemption_fee_bps(e, params.early_redemption_fee_bps);

        // Initial state
        put_vault_state(e, VaultState::Funding);
        put_paused(e, false);
        put_freeze_flags(e, 0u32);
        put_locked(e, false);
        put_current_epoch(e, 0u32);
        put_total_yield_distributed(e, 0i128);
        put_redemption_counter(e, 0u32);
        put_total_supply(e, 0i128);
        put_transfer_requires_kyc(e, true);
        put_total_deposited(e, 0i128);

        // Versioning
        put_contract_version(e, 1u32);
        put_storage_schema_version(e, 1u32);

        e.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    // ─────────────────────────────────────────────────────────────────
    // RWA details
    // ─────────────────────────────────────────────────────────────────

    pub fn get_rwa_details(e: &Env) -> RwaDetails {
        RwaDetails {
            name: get_rwa_name(e),
            symbol: get_rwa_symbol(e),
            document_uri: get_rwa_document_uri(e),
            category: get_rwa_category(e),
            expected_apy: get_expected_apy(e),
        }
    }

    pub fn rwa_name(e: &Env) -> String {
        get_rwa_name(e)
    }
    pub fn rwa_symbol(e: &Env) -> String {
        get_rwa_symbol(e)
    }
    pub fn rwa_document_uri(e: &Env) -> String {
        get_rwa_document_uri(e)
    }
    pub fn rwa_category(e: &Env) -> String {
        get_rwa_category(e)
    }

    /// Update all RWA metadata fields. Admin-only.
    pub fn set_rwa_details(
        e: &Env,
        caller: Address,
        name: String,
        symbol: String,
        document_uri: String,
        category: String,
        expected_apy: u32,
    ) {
        caller.require_auth();
        require_admin(e, &caller);
        put_rwa_name(e, name.clone());
        put_rwa_symbol(e, symbol.clone());
        put_rwa_document_uri(e, document_uri.clone());
        put_rwa_category(e, category.clone());
        put_expected_apy(e, expected_apy);
        emit_rwa_details_updated(e, name, symbol, document_uri, category, expected_apy);
        bump_instance(e);
    }

    /// Update only the RWA document URI. Admin-only.
    pub fn set_rwa_document_uri(e: &Env, caller: Address, document_uri: String) {
        caller.require_auth();
        require_admin(e, &caller);
        put_rwa_document_uri(e, document_uri.clone());
        emit_rwa_details_updated(
            e,
            get_rwa_name(e),
            get_rwa_symbol(e),
            document_uri,
            get_rwa_category(e),
            get_expected_apy(e),
        );
        bump_instance(e);
    }

    /// Update only the expected APY. Admin-only.
    pub fn set_expected_apy(e: &Env, caller: Address, expected_apy: u32) {
        caller.require_auth();
        require_admin(e, &caller);
        put_expected_apy(e, expected_apy);
        emit_rwa_details_updated(
            e,
            get_rwa_name(e),
            get_rwa_symbol(e),
            get_rwa_document_uri(e),
            get_rwa_category(e),
            expected_apy,
        );
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // zkMe KYC
    // ─────────────────────────────────────────────────────────────────

    /// Returns true when the user has passed KYC (or when no verifier is set).
    pub fn is_kyc_verified(e: &Env, user: Address) -> bool {
        let verifier = get_zkme_verifier(e);
        // If verifier is the zero-equivalent (contract itself) → allow all
        if verifier == e.current_contract_address() {
            return true;
        }
        let coop = get_cooperator(e);
        let client = ZkmeVerifyClient::new(e, &verifier);
        client.has_approved(&coop, &user)
    }

    pub fn zkme_verifier(e: &Env) -> Address {
        get_zkme_verifier(e)
    }
    pub fn cooperator(e: &Env) -> Address {
        get_cooperator(e)
    }

    pub fn set_zkme_verifier(e: &Env, caller: Address, verifier: Address) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        let old = get_zkme_verifier(e);
        put_zkme_verifier(e, verifier.clone());
        emit_zkme_verifier_updated(e, old, verifier);
        bump_instance(e);
    }

    pub fn set_cooperator(e: &Env, caller: Address, new_cooperator: Address) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        let old = get_cooperator(e);
        put_cooperator(e, new_cooperator.clone());
        emit_cooperator_updated(e, old, new_cooperator);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Core vault operations — Deposit / Mint / Withdraw / Redeem
    // (ERC-4626 semantics adapted for Soroban)
    // ─────────────────────────────────────────────────────────────────

    /// Deposit `assets` of the underlying token; mint vault shares to `receiver`.
    /// Caller must be KYC-verified.
    ///
    /// Security: follows the Checks-Effects-Interactions (CEI) pattern.
    /// All state changes (_mint, deposit tracking) are committed before the
    /// external token transfer so that a reentrant call observes fully-updated
    /// state.  The reentrancy lock provides an additional hard stop against
    /// any reentrant execution path.
    pub fn deposit(e: &Env, caller: Address, assets: i128, receiver: Address) -> i128 {
        caller.require_auth();
        // --- Checks ---
        require_current_schema(e);
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_DEPOSIT_MINT);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &receiver);
        require_kyc_verified(e, &caller);
        require_active_or_funding(e);

        let min_dep = get_min_deposit(e);
        if assets < min_dep {
            panic_with_error!(e, Error::BelowMinimumDeposit);
        }
        let max_dep = get_max_deposit_per_user(e);
        if max_dep > 0 {
            let already = get_user_deposited(e, &receiver);
            if already + assets > max_dep {
                panic_with_error!(e, Error::ExceedsMaximumDeposit);
            }
        }

        if get_vault_state(e) == VaultState::Funding {
            let target = get_funding_target(e);
            if target > 0 {
                let current = total_assets(e);
                if current + assets > target {
                    panic_with_error!(e, Error::FundingTargetExceeded);
                }
            }
        }

        // Shares = assets (1:1 at start; yield accrual changes the price)
        let shares = preview_deposit(e, assets);

        // --- Effects (state changes first) ---
        update_user_snapshot(e, &receiver);
        put_user_deposited(e, &receiver, get_user_deposited(e, &receiver) + assets);
        put_total_deposited(e, get_total_deposited(e) + assets);
        _mint(e, &receiver, shares);

        // --- Interaction (external call last) ---
        transfer_asset_to_vault(e, &caller, assets);

        emit_deposit(e, caller, receiver, assets, shares);
        bump_instance(e);
        release_lock(e);
        shares
    }

    /// Mint exactly `shares`; caller pays the corresponding assets.
    ///
    /// Security: follows CEI — all state changes committed before the external
    /// token transfer.  Reentrancy lock prevents reentrant calls.
    pub fn mint(e: &Env, caller: Address, shares: i128, receiver: Address) -> i128 {
        caller.require_auth();
        // --- Checks ---
        require_current_schema(e);
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_DEPOSIT_MINT);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &receiver);
        require_kyc_verified(e, &caller);
        require_active_or_funding(e);

        let assets = preview_mint(e, shares);
        let min_dep = get_min_deposit(e);
        if assets < min_dep {
            panic_with_error!(e, Error::BelowMinimumDeposit);
        }
        let max_dep = get_max_deposit_per_user(e);
        if max_dep > 0 {
            let already = get_user_deposited(e, &receiver);
            if already + assets > max_dep {
                panic_with_error!(e, Error::ExceedsMaximumDeposit);
            }
        }

        if get_vault_state(e) == VaultState::Funding {
            let target = get_funding_target(e);
            if target > 0 {
                let current = total_assets(e);
                if current + assets > target {
                    panic_with_error!(e, Error::FundingTargetExceeded);
                }
            }
        }

        // --- Effects (state changes first) ---
        update_user_snapshot(e, &receiver);
        put_user_deposited(e, &receiver, get_user_deposited(e, &receiver) + assets);
        put_total_deposited(e, get_total_deposited(e) + assets);
        _mint(e, &receiver, shares);

        // --- Interaction (external call last) ---
        transfer_asset_to_vault(e, &caller, assets);

        emit_deposit(e, caller, receiver, assets, shares);
        bump_instance(e);
        release_lock(e);
        assets
    }

    /// Withdraw exactly `assets` worth of underlying; burns the corresponding shares.
    ///
    /// **State guard:** Only allowed in `Active` or `Matured` states.
    /// During `Funding` the investment has not started so there is nothing to
    /// withdraw, and a `Closed` vault has already been wound down.  The
    /// `Active + Matured` policy keeps parity with `redeem` and lets LPs exit
    /// once the RWA is live while still permitting withdrawals after maturity
    /// for users who prefer the asset-denominated call over `redeem_at_maturity`.
    ///
    /// Security: follows CEI — shares are burned (state change) before the
    /// external asset transfer.  Reentrancy lock prevents reentrant calls.
    pub fn withdraw(
        e: &Env,
        caller: Address,
        assets: i128,
        receiver: Address,
        owner: Address,
    ) -> i128 {
        caller.require_auth();
        // --- Checks ---
        require_current_schema(e);
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_WITHDRAW_REDEEM);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &owner);
        require_not_blacklisted(e, &receiver);
        require_active_or_matured(e);

        if assets <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        let shares = preview_withdraw(e, assets);

        if caller != owner {
            let allowance = get_share_allowance(e, &owner, &caller);
            if allowance < shares {
                panic_with_error!(e, Error::InsufficientAllowance);
            }
            // --- Effects ---
            put_share_allowance(e, &owner, &caller, allowance - shares);
        }

        // --- Effects ---
        update_user_snapshot(e, &owner);
        _burn(e, &owner, shares);
        put_total_deposited(e, get_total_deposited(e) - assets);

        let user_dep = get_user_deposited(e, &owner);
        put_user_deposited(e, &owner, (user_dep - assets).max(0));

        // --- Interaction ---
        transfer_asset_from_vault(e, &receiver, assets);

        emit_withdraw(e, caller, receiver, owner, assets, shares);
        bump_instance(e);
        release_lock(e);
        shares
    }

    /// Redeem `shares`; receive the corresponding underlying assets.
    ///
    /// **State guard:** Only allowed in `Active` or `Matured` states.
    /// During `Funding` no investment has been made yet, and `Closed` vaults
    /// have already been wound down.  For maturity-specific redemption with
    /// automatic yield claiming use `redeem_at_maturity` instead.
    pub fn redeem(
        e: &Env,
        caller: Address,
        shares: i128,
        receiver: Address,
        owner: Address,
    ) -> i128 {
        caller.require_auth();
        // --- Checks ---
        require_current_schema(e);
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_WITHDRAW_REDEEM);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &owner);
        require_not_blacklisted(e, &receiver);
        require_active_or_matured(e);

        if shares <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        if caller != owner {
            let allowance = get_share_allowance(e, &owner, &caller);
            if allowance < shares {
                panic_with_error!(e, Error::InsufficientAllowance);
            }
            // --- Effects ---
            put_share_allowance(e, &owner, &caller, allowance - shares);
        }

        // --- Effects ---
        update_user_snapshot(e, &owner);
        let assets = preview_redeem(e, shares);
        _burn(e, &owner, shares);
        put_total_deposited(e, get_total_deposited(e) - assets);

        let user_dep = get_user_deposited(e, &owner);
        put_user_deposited(e, &owner, (user_dep - assets).max(0));

        // --- Interaction ---
        transfer_asset_from_vault(e, &receiver, assets);

        emit_withdraw(e, caller, receiver, owner, assets, shares);
        bump_instance(e);
        release_lock(e);
        assets
    }

    // ─────────────────────────────────────────────────────────────────
    // ERC-4626 preview helpers
    // ─────────────────────────────────────────────────────────────────

    /// ERC-4626 `previewDeposit`: shares received for `assets` deposited (rounding **down**).
    /// Favors the vault — user receives fewer shares than the ideal rational amount.
    /// Reverts when `assets > 0` but the rounded share amount is 0 (dust donation guard).
    pub fn preview_deposit(e: &Env, assets: i128) -> i128 {
        preview_deposit(e, assets)
    }
    /// ERC-4626 `previewMint`: assets paid to mint exactly `shares` (rounding **up**).
    /// Favors the vault — user pays at least the ideal asset amount.
    pub fn preview_mint(e: &Env, shares: i128) -> i128 {
        preview_mint(e, shares)
    }
    /// ERC-4626 `previewWithdraw`: shares burned to withdraw exactly `assets` (rounding **up**).
    /// Favors the vault — user burns at least the ideal share amount.
    pub fn preview_withdraw(e: &Env, assets: i128) -> i128 {
        preview_withdraw(e, assets)
    }
    /// ERC-4626 `previewRedeem`: assets received when redeeming `shares` (rounding **down**).
    /// Favors the vault — user receives fewer assets than the ideal rational amount.
    /// Reverts when `shares > 0` but the rounded asset amount is 0 (dust redemption guard).
    pub fn preview_redeem(e: &Env, shares: i128) -> i128 {
        preview_redeem(e, shares)
    }

    // ERC-4626 pure conversion helpers (floor division)
    // ─────────────────────────────────────────────────────────────────

    pub fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        if supply == 0 || ta == 0 {
            return assets;
        }
        // shares = assets * totalSupply / totalAssets (floor)
        math::mul_div(e, assets, supply, ta)
    }

    pub fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        if supply == 0 {
            return shares;
        }
        // assets = shares * totalAssets / totalSupply (floor)
        math::mul_div(e, shares, ta, supply)
    }

    pub fn redemption_request(e: &Env, request_id: u32) -> RedemptionRequest {
        get_redemption_request(e, request_id)
    }

    /// Returns the current redemption request counter (total number of requests ever made).
    pub fn redemption_counter(e: &Env) -> u32 {
        get_redemption_counter(e)
    }

    /// Returns all redemption request IDs for a given user.
    pub fn get_user_redemption_requests(e: &Env, user: Address) -> Vec<u32> {
        get_user_redemption_requests(e, &user)
    }

    // ─────────────────────────────────────────────────────────────────
    // ERC-4626 max helpers
    // ─────────────────────────────────────────────────────────────────

    /// Maximum assets `receiver` can deposit right now.
    /// Returns 0 when the vault is paused or not in Funding/Active state.
    /// When `max_deposit_per_user` is 0 the vault is uncapped; returns i128::MAX.
    pub fn max_deposit(e: &Env, receiver: Address) -> i128 {
        if get_paused(e) {
            return 0;
        }
        let state = get_vault_state(e);
        if state != VaultState::Funding && state != VaultState::Active {
            return 0;
        }
        let cap = get_max_deposit_per_user(e);
        let mut max_allowed = if cap == 0 {
            i128::MAX
        } else {
            let already = get_user_deposited(e, &receiver);
            (cap - already).max(0)
        };

        if state == VaultState::Funding {
            let target = get_funding_target(e);
            if target > 0 {
                let current = total_assets(e);
                let remaining = (target - current).max(0);
                max_allowed = max_allowed.min(remaining);
            }
        }

        max_allowed
    }

    /// Maximum shares `receiver` can obtain via `mint` right now.
    /// Converts `max_deposit` to shares using the current share price.
    /// Returns 0 when the vault is paused or not in Funding/Active state.
    pub fn max_mint(e: &Env, receiver: Address) -> i128 {
        let max_assets = Self::max_deposit(e, receiver);
        if max_assets == 0 {
            return 0;
        }
        if max_assets == i128::MAX {
            return i128::MAX;
        }
        // Floor conversion — may be 0 when `max_deposit` is below one full share in
        // asset terms; must not panic (unlike `preview_deposit` for user-supplied amounts).
        convert_to_shares_floor(e, max_assets)
    }

    /// Maximum assets `owner` can withdraw right now.
    /// Returns 0 when the vault is paused or not in Active/Matured state.
    pub fn max_withdraw(e: &Env, owner: Address) -> i128 {
        if get_paused(e) {
            return 0;
        }
        let state = get_vault_state(e);
        if state != VaultState::Active && state != VaultState::Matured {
            return 0;
        }
        let shares = get_share_balance(e, &owner);
        // Floor conversion for a view helper — may be 0 for dust balances; must not panic.
        convert_to_assets_floor(e, shares)
    }

    /// Maximum shares `owner` can redeem right now (their full share balance).
    /// Returns 0 when the vault is paused or not in Active/Matured state.
    pub fn max_redeem(e: &Env, owner: Address) -> i128 {
        if get_paused(e) {
            return 0;
        }
        let state = get_vault_state(e);
        if state != VaultState::Active && state != VaultState::Matured {
            return 0;
        }
        get_share_balance(e, &owner)
    }

    pub fn total_assets(e: &Env) -> i128 {
        total_assets(e)
    }

    // ─────────────────────────────────────────────────────────────────
    // Yield distribution
    // ─────────────────────────────────────────────────────────────────

    /// Operator transfers `amount` of asset into the vault and records a new epoch.
    ///
    /// Security: follows CEI — epoch counters and yield accounting are updated
    /// (Effects) before the external token pull (Interaction).  This ensures
    /// that any reentrant call sees a fully-consistent epoch state.
    /// Reentrancy lock provides an additional hard stop.
    pub fn distribute_yield(e: &Env, caller: Address, amount: i128) -> u32 {
        caller.require_auth();
        // --- Checks ---
        require_current_schema(e);
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_YIELD);
        // YieldOperator role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::YieldOperator);
        require_state(e, VaultState::Active);

        if amount <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        // --- Effects (state changes before external call) ---
        let epoch = get_current_epoch(e) + 1;
        put_current_epoch(e, epoch);
        put_epoch_yield(e, epoch, amount);
        put_epoch_total_shares(e, epoch, get_total_supply(e));
        put_epoch_timestamp(e, epoch, e.ledger().timestamp());
        put_total_yield_distributed(e, get_total_yield_distributed(e) + amount);
        put_total_deposited(e, get_total_deposited(e) + amount);

        emit_yield_distributed(e, epoch, amount, e.ledger().timestamp());

        // --- Interaction (pull yield tokens into vault last) ---
        transfer_asset_to_vault(e, &caller, amount);

        bump_instance(e);
        release_lock(e);
        epoch
    }

    /// Claim all pending yield for the caller.
    ///
    /// Security: follows CEI — epoch claim flags and totals are committed
    /// (Effects) before the asset transfer (Interaction).  Reentrancy lock
    /// prevents double-claim via reentrant calls.
    pub fn claim_yield(e: &Env, caller: Address) -> i128 {
        caller.require_auth();
        // --- Checks ---
        require_current_schema(e);
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_YIELD);
        require_active_or_matured(e);
        require_not_blacklisted(e, &caller);

        let amount = Self::pending_yield(e, caller.clone());
        if amount <= 0 {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        // --- Effects ---
        let epoch = get_current_epoch(e);
        let last_claimed = get_last_claimed_epoch(e, &caller);
        // Mark every epoch in the unclaimed window as claimed — including epochs
        // where the user had 0 shares.  This prevents the loop from re-scanning
        // dead epochs on every subsequent call (O(new_epochs) instead of O(total)).
        for i in (last_claimed + 1)..=epoch {
            put_has_claimed_epoch(e, &caller, i, true);
        }
        put_last_claimed_epoch(e, &caller, epoch);

        put_total_yield_claimed(e, &caller, get_total_yield_claimed(e, &caller) + amount);
        transfer_asset_from_vault(e, &caller, amount);

        emit_yield_claimed(e, caller, amount, epoch);
        bump_instance(e);
        release_lock(e);
        amount
    }

    /// Claim yield for a specific epoch only.
    ///
    /// Security: follows CEI — epoch claim flag and running total are updated
    /// (Effects) before the asset transfer (Interaction).  Reentrancy lock
    /// prevents double-claim via reentrant calls.
    pub fn claim_yield_for_epoch(e: &Env, caller: Address, epoch: u32) -> i128 {
        caller.require_auth();
        // --- Checks ---
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_YIELD);
        require_active_or_matured(e);
        require_not_blacklisted(e, &caller);

        if get_has_claimed_epoch(e, &caller, epoch) {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        let amount = Self::pending_yield_for_epoch(e, caller.clone(), epoch);
        if amount <= 0 {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        // --- Effects ---
        put_has_claimed_epoch(e, &caller, epoch, true);
        // Advance the cursor: if this epoch is the next sequential one after
        // the cursor, walk forward over any already-claimed epochs too.
        let mut cursor = get_last_claimed_epoch(e, &caller);
        let current = get_current_epoch(e);
        while cursor < current && get_has_claimed_epoch(e, &caller, cursor + 1) {
            cursor += 1;
        }
        put_last_claimed_epoch(e, &caller, cursor);

        put_total_yield_claimed(e, &caller, get_total_yield_claimed(e, &caller) + amount);
        transfer_asset_from_vault(e, &caller, amount);

        emit_yield_claimed(e, caller, amount, epoch);
        bump_instance(e);
        release_lock(e);
        amount
    }

    pub fn pending_yield(e: &Env, user: Address) -> i128 {
        let epoch = get_current_epoch(e);
        // Start from the cursor so we skip already-claimed epochs entirely.
        let start = get_last_claimed_epoch(e, &user) + 1;
        let mut total = 0i128;
        for i in start..=epoch {
            if !get_has_claimed_epoch(e, &user, i) {
                total += Self::pending_yield_for_epoch(e, user.clone(), i);
            }
        }
        total
    }

    pub fn pending_yield_for_epoch(e: &Env, user: Address, epoch: u32) -> i128 {
        let cur = get_current_epoch(e);
        if epoch == 0 || epoch > cur || get_has_claimed_epoch(e, &user, epoch) {
            return 0;
        }
        let user_shares = _get_user_shares_for_epoch(e, &user, epoch);
        let total_shares = get_epoch_total_shares(e, epoch);
        if total_shares == 0 || user_shares == 0 {
            return 0;
        }
        math::mul_div(e, get_epoch_yield(e, epoch), user_shares, total_shares)
    }

    pub fn current_epoch(e: &Env) -> u32 {
        get_current_epoch(e)
    }
    pub fn epoch_yield(e: &Env, epoch: u32) -> i128 {
        get_epoch_yield(e, epoch)
    }
    pub fn total_yield_distributed(e: &Env) -> i128 {
        get_total_yield_distributed(e)
    }
    pub fn total_yield_claimed(e: &Env, user: Address) -> i128 {
        get_total_yield_claimed(e, &user)
    }

    /// The highest epoch at which all epochs ≤ cursor have been fully claimed
    /// by `user`.  `pending_yield` scans from `last_claimed_epoch + 1` onwards.
    pub fn last_claimed_epoch(e: &Env, user: Address) -> u32 {
        get_last_claimed_epoch(e, &user)
    }

    /// Get detailed data for a single epoch.
    pub fn get_epoch_data(e: &Env, epoch: u32) -> EpochData {
        let yield_amount = get_epoch_yield(e, epoch);
        let total_shares = get_epoch_total_shares(e, epoch);
        let yield_per_share = if total_shares > 0 {
            yield_amount * PRECISION / total_shares
        } else {
            0
        };
        EpochData {
            epoch,
            yield_amount,
            total_shares,
            yield_per_share,
            timestamp: get_epoch_timestamp(e, epoch),
        }
    }

    /// Get epoch data for a range [start, end] inclusive.
    /// Maximum range size is 50 epochs.
    pub fn get_epoch_range(e: &Env, start: u32, end: u32) -> Vec<EpochData> {
        const MAX_RANGE: u32 = 50;
        if start == 0 || start > end {
            panic_with_error!(e, Error::InvalidEpochRange);
        }
        let current = get_current_epoch(e);
        let actual_end = end.min(current);
        if actual_end < start {
            return Vec::new(e);
        }
        if actual_end - start + 1 > MAX_RANGE {
            panic_with_error!(e, Error::InvalidEpochRange);
        }
        let mut result: Vec<EpochData> = Vec::new(e);
        for epoch in start..=actual_end {
            result.push_back(Self::get_epoch_data(e, epoch));
        }
        result
    }

    /// Get aggregate yield statistics for the vault.
    pub fn get_yield_summary(e: &Env) -> YieldSummary {
        let total_epochs = get_current_epoch(e);
        let total_yield = get_total_yield_distributed(e);
        let average_yield = if total_epochs > 0 {
            total_yield / total_epochs as i128
        } else {
            0
        };
        let latest_epoch_yield = if total_epochs > 0 {
            get_epoch_yield(e, total_epochs)
        } else {
            0
        };
        YieldSummary {
            total_epochs,
            total_yield_distributed: total_yield,
            average_yield_per_epoch: average_yield,
            latest_epoch_yield,
            earliest_epoch: if total_epochs > 0 { 1 } else { 0 },
            latest_epoch: total_epochs,
        }
    }

    /// Get per-epoch yield breakdown for a user over a range [start_epoch, end_epoch].
    /// Maximum range size is 50 epochs.
    pub fn get_user_yield_history(
        e: &Env,
        user: Address,
        start_epoch: u32,
        end_epoch: u32,
    ) -> Vec<UserEpochYield> {
        const MAX_RANGE: u32 = 50;
        if start_epoch == 0 || start_epoch > end_epoch {
            panic_with_error!(e, Error::InvalidEpochRange);
        }
        let current = get_current_epoch(e);
        let actual_end = end_epoch.min(current);
        if actual_end < start_epoch {
            return Vec::new(e);
        }
        if actual_end - start_epoch + 1 > MAX_RANGE {
            panic_with_error!(e, Error::InvalidEpochRange);
        }
        let mut result: Vec<UserEpochYield> = Vec::new(e);
        for epoch in start_epoch..=actual_end {
            let user_shares = _get_user_shares_for_epoch(e, &user, epoch);
            let total_shares = get_epoch_total_shares(e, epoch);
            let yield_amount = get_epoch_yield(e, epoch);
            let yield_earned = if total_shares > 0 {
                yield_amount * user_shares / total_shares
            } else {
                0
            };
            result.push_back(UserEpochYield {
                epoch,
                user_shares,
                yield_earned,
                claimed: get_has_claimed_epoch(e, &user, epoch),
            });
        }
        result
    }

    // ─────────────────────────────────────────────────────────────────
    // Vault lifecycle
    // ─────────────────────────────────────────────────────────────────

    pub fn vault_state(e: &Env) -> VaultState {
        get_vault_state(e)
    }

    pub fn activate_vault(e: &Env, operator: Address) {
        operator.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &operator, Role::LifecycleManager);
        require_state(e, VaultState::Funding);
        // Cannot activate once the funding deadline has passed.
        let deadline = get_funding_deadline(e);
        if deadline > 0 && e.ledger().timestamp() > deadline {
            panic_with_error!(e, Error::FundingDeadlinePassed);
        }
        if !Self::is_funding_target_met(e) {
            panic_with_error!(e, Error::FundingTargetNotMet);
        }
        put_vault_state(e, VaultState::Active);
        put_activation_timestamp(e, e.ledger().timestamp());
        emit_vault_state_changed(e, VaultState::Funding, VaultState::Active);
        bump_instance(e);
    }

    /// Cancel a failed funding round.
    ///
    /// Operator-only.  Callable only when the vault is in Funding state,
    /// the funding deadline has passed, and the funding target has not been met.
    /// Transitions the vault to Cancelled, enabling individual `refund` calls.
    pub fn cancel_funding(e: &Env, caller: Address) {
        caller.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::LifecycleManager);
        require_state(e, VaultState::Funding);
        // Deadline must have passed.
        let deadline = get_funding_deadline(e);
        if deadline == 0 || e.ledger().timestamp() <= deadline {
            panic_with_error!(e, Error::FundingDeadlineNotPassed);
        }
        // Funding target must still be unmet.
        if Self::is_funding_target_met(e) {
            panic_with_error!(e, Error::FundingTargetNotMet);
        }
        put_vault_state(e, VaultState::Cancelled);
        emit_vault_state_changed(e, VaultState::Funding, VaultState::Cancelled);
        emit_funding_cancelled(e);
        bump_instance(e);
    }

    /// Refund a depositor after a cancelled funding round.
    ///
    /// Burns the caller's shares 1:1 and returns the corresponding deposited
    /// assets.  Only callable when the vault is in Cancelled state.
    ///
    /// Security: follows CEI — shares are burned (Effect) before the asset
    /// transfer (Interaction).  Reentrancy lock prevents double-refund.
    pub fn refund(e: &Env, caller: Address) -> i128 {
        caller.require_auth();
        // --- Checks ---
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_WITHDRAW_REDEEM);
        require_state(e, VaultState::Cancelled);

        let shares = get_share_balance(e, &caller);
        if shares <= 0 {
            panic_with_error!(e, Error::NoSharesToRefund);
        }

        // In Funding state no yield accrues, so the share price is always 1:1.
        // preview_redeem handles this correctly (totalAssets == totalSupply).
        let amount = preview_redeem(e, shares);

        // --- Effects ---
        put_user_deposited(e, &caller, 0);
        _burn(e, &caller, shares);
        put_total_deposited(e, get_total_deposited(e) - amount);

        // --- Interaction ---
        transfer_asset_from_vault(e, &caller, amount);

        emit_refunded(e, caller, amount);
        bump_instance(e);
        release_lock(e);
        amount
    }

    /// Returns the funding deadline timestamp (0 = no deadline configured).
    pub fn funding_deadline(e: &Env) -> u64 {
        get_funding_deadline(e)
    }

    /// Transition Active → Matured.  Requires block timestamp ≥ maturityDate.
    pub fn mature_vault(e: &Env, caller: Address) {
        caller.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::LifecycleManager);
        require_state(e, VaultState::Active);
        let now = e.ledger().timestamp();
        if now < get_maturity_date(e) {
            panic_with_error!(e, Error::NotMatured);
        }
        put_vault_state(e, VaultState::Matured);
        emit_vault_state_changed(e, VaultState::Active, VaultState::Matured);
        bump_instance(e);
    }

    /// Transition Matured → Closed.
    ///
    /// Requires that all shares have been redeemed (total_supply == 0).
    /// Closed is a terminal state; no further operations are possible.
    pub fn close_vault(e: &Env, caller: Address) {
        caller.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::LifecycleManager);
        require_state(e, VaultState::Matured);

        if get_total_supply(e) > 0 {
            panic_with_error!(e, Error::VaultNotEmpty);
        }

        put_vault_state(e, VaultState::Closed);
        emit_vault_state_changed(e, VaultState::Matured, VaultState::Closed);
        bump_instance(e);
    }

    pub fn set_maturity_date(e: &Env, caller: Address, timestamp: u64) {
        caller.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::LifecycleManager);
        require_not_closed(e);
        put_maturity_date(e, timestamp);
        emit_maturity_date_set(e, timestamp);
        bump_instance(e);
    }

    pub fn maturity_date(e: &Env) -> u64 {
        get_maturity_date(e)
    }
    pub fn funding_target(e: &Env) -> i128 {
        get_funding_target(e)
    }

    pub fn is_funding_target_met(e: &Env) -> bool {
        let (target, assets) = (get_funding_target(e), total_assets(e));
        assets >= target
    }

    pub fn time_to_maturity(e: &Env) -> u64 {
        let now = e.ledger().timestamp();
        let mat = get_maturity_date(e);
        mat.saturating_sub(now)
    }

    // ─────────────────────────────────────────────────────────────────
    // Deposit limits
    // ─────────────────────────────────────────────────────────────────

    pub fn min_deposit(e: &Env) -> i128 {
        get_min_deposit(e)
    }
    pub fn max_deposit_per_user(e: &Env) -> i128 {
        get_max_deposit_per_user(e)
    }
    pub fn user_deposited(e: &Env, user: Address) -> i128 {
        get_user_deposited(e, &user)
    }

    pub fn set_deposit_limits(e: &Env, caller: Address, min_amount: i128, max_amount: i128) {
        caller.require_auth();

        // --- Validation ---
        if min_amount < 0 || max_amount < 0 {
            panic_with_error!(e, Error::InvalidDepositLimits);
        }
        // When both limits are non-zero, max must be >= min.
        if min_amount > 0 && max_amount > 0 && max_amount < min_amount {
            panic_with_error!(e, Error::InvalidDepositLimits);
        }

        // --- State guard ---
        // Funding: any operator may update limits.
        // Active:  only the admin may update limits (requires their explicit auth).
        // All other states: not permitted.
        let state = get_vault_state(e);
        match state {
            VaultState::Funding => require_role(e, &caller, Role::FullOperator),
            VaultState::Active => require_admin(e, &caller),
            _ => panic_with_error!(e, Error::InvalidVaultState),
        }

        put_min_deposit(e, min_amount);
        put_max_deposit_per_user(e, max_amount);
        emit_deposit_limits_updated(e, min_amount, max_amount);
        bump_instance(e);
    }

    /// Set only the minimum deposit amount.
    ///
    /// State guard: callable by any operator during Funding; only by admin during Active.
    pub fn set_min_deposit(e: &Env, caller: Address, amount: i128) {
        caller.require_auth();

        if amount < 0 {
            panic_with_error!(e, Error::InvalidDepositLimits);
        }
        // Ensure min ≤ max when both are non-zero.
        let current_max = get_max_deposit_per_user(e);
        if amount > 0 && current_max > 0 && amount > current_max {
            panic_with_error!(e, Error::InvalidDepositLimits);
        }

        let state = get_vault_state(e);
        match state {
            VaultState::Funding => require_role(e, &caller, Role::FullOperator),
            VaultState::Active => require_admin(e, &caller),
            _ => panic_with_error!(e, Error::InvalidVaultState),
        }

        put_min_deposit(e, amount);
        emit_deposit_limits_updated(e, amount, get_max_deposit_per_user(e));
        bump_instance(e);
    }

    /// Set only the maximum deposit per user.
    ///
    /// State guard: callable by any operator during Funding; only by admin during Active.
    /// Lowering the cap below an existing depositor's balance does not affect their
    /// existing position — only new deposits will be blocked.
    pub fn set_max_deposit_per_user(e: &Env, caller: Address, amount: i128) {
        caller.require_auth();

        if amount < 0 {
            panic_with_error!(e, Error::InvalidDepositLimits);
        }
        // Ensure max ≥ min when both are non-zero.
        let current_min = get_min_deposit(e);
        if amount > 0 && current_min > 0 && amount < current_min {
            panic_with_error!(e, Error::InvalidDepositLimits);
        }

        let state = get_vault_state(e);
        match state {
            VaultState::Funding => require_role(e, &caller, Role::FullOperator),
            VaultState::Active => require_admin(e, &caller),
            _ => panic_with_error!(e, Error::InvalidVaultState),
        }

        put_max_deposit_per_user(e, amount);
        emit_deposit_limits_updated(e, get_min_deposit(e), amount);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Redemption
    // ─────────────────────────────────────────────────────────────────

    /// Full redemption at maturity.  Automatically claims pending yield.
    ///
    /// Security: follows CEI — all yield-claim state, allowance deduction, and
    /// share burn are committed before the single outgoing asset transfer.
    /// Reentrancy lock prevents reentrant calls.
    pub fn redeem_at_maturity(
        e: &Env,
        caller: Address,
        shares: i128,
        receiver: Address,
        owner: Address,
    ) -> i128 {
        caller.require_auth();
        // --- Checks ---
        acquire_lock(e);
        require_not_frozen(e, Self::FREEZE_WITHDRAW_REDEEM);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &owner);
        require_not_blacklisted(e, &receiver);
        require_state(e, VaultState::Matured);

        if shares <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        if caller != owner {
            let allowance = get_share_allowance(e, &owner, &caller);
            if allowance < shares {
                panic_with_error!(e, Error::InsufficientAllowance);
            }
            // --- Effects ---
            put_share_allowance(e, &owner, &caller, allowance - shares);
        }

        // --- Effects: auto-claim pending yield ---
        let pending = Self::pending_yield(e, owner.clone());
        let epoch = get_current_epoch(e);
        if pending > 0 {
            for i in 1..=epoch {
                put_has_claimed_epoch(e, &owner, i, true);
            }
            put_total_yield_claimed(e, &owner, get_total_yield_claimed(e, &owner) + pending);
        }

        update_user_snapshot(e, &owner);
        let assets = preview_redeem(e, shares);
        _burn(e, &owner, shares);
        put_total_deposited(e, get_total_deposited(e) - assets);

        let user_dep = get_user_deposited(e, &owner);
        put_user_deposited(e, &owner, (user_dep - assets).max(0));

        let mut total_out = assets;
        if pending > 0 {
            total_out += pending;
        }

        // --- Interaction ---
        transfer_asset_from_vault(e, &receiver, total_out);

        // Emit ERC-4626 compliant Withdraw event
        emit_withdraw(
            e,
            caller.clone(),
            receiver.clone(),
            owner.clone(),
            assets,
            shares,
        );
        // Emit custom maturity redemption event with yield info
        emit_redeem_at_maturity(e, owner, receiver, shares, assets, pending);
        bump_instance(e);
        release_lock(e);
        total_out
    }

    /// Request early redemption (pending operator approval).
    pub fn request_early_redemption(e: &Env, caller: Address, shares: i128) -> u32 {
        caller.require_auth();
        require_not_frozen(e, Self::FREEZE_WITHDRAW_REDEEM);
        require_not_closed(e);
        require_not_blacklisted(e, &caller);

        if shares <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        update_user_snapshot(e, &caller);

        let bal = get_share_balance(e, &caller);
        if bal < shares {
            panic_with_error!(e, Error::InsufficientBalance);
        }

        // --- Effects (Escrow shares) ---
        put_share_balance(e, &caller, bal - shares);
        let escrowed = get_escrowed_shares(e, &caller) + shares;
        put_escrowed_shares(e, &caller, escrowed);
        bump_balance(e, &caller);

        let id = get_redemption_counter(e) + 1;
        put_redemption_counter(e, id);
        let user = caller.clone();
        put_redemption_request(
            e,
            id,
            RedemptionRequest {
                user: caller.clone(),
                shares,
                request_time: e.ledger().timestamp(),
                processed: false,
            },
        );
        // Track the request ID in the user's list for queryability
        push_user_redemption_request(e, &user, id);

        emit_early_redemption_requested(e, user, id, shares);
        bump_instance(e);
        id
    }

    /// Operator processes an early redemption request.
    ///
    /// Security: follows CEI — the request is marked processed and shares are
    /// burned from escrow (Effects) before the asset transfer (Interaction).
    /// Reentrancy lock prevents reentrant calls from processing the same request twice.
    pub fn process_early_redemption(e: &Env, operator: Address, request_id: u32) {
        operator.require_auth();
        // --- Checks ---
        acquire_lock(e);
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &operator, Role::LifecycleManager);

        let mut req = get_redemption_request(e, request_id);
        if req.processed {
            panic_with_error!(e, Error::AlreadyProcessed);
        }

        let escrowed = get_escrowed_shares(e, &req.user);
        if escrowed < req.shares {
            panic_with_error!(e, Error::InsufficientBalance);
        }

        // Payout math before irreversible updates — `preview_redeem` may panic on dust
        // (ERC-4626 zero-asset guard) and must not run after escrow/supply are changed.
        let assets = preview_redeem(e, req.shares);
        let fee_bps = get_early_redemption_fee_bps(e) as i128;
        let fee = math::mul_div(e, assets, fee_bps, 10000);
        let net_assets = assets - fee;

        // --- Effects ---
        req.processed = true;
        put_redemption_request(e, request_id, req.clone());
        put_escrowed_shares(e, &req.user, escrowed - req.shares);
        put_total_supply(e, get_total_supply(e) - req.shares);
        put_total_deposited(e, get_total_deposited(e) - net_assets);

        let user_dep = get_user_deposited(e, &req.user);
        put_user_deposited(e, &req.user, (user_dep - net_assets).max(0));

        // --- Interaction ---
        transfer_asset_from_vault(e, &req.user, net_assets);
        // Fee stays in vault for other depositors

        emit_early_redemption_processed(e, req.user, request_id, net_assets);
        bump_instance(e);
        release_lock(e);
    }

    /// Cancel an early redemption request and return shares from escrow.
    pub fn cancel_early_redemption(e: &Env, caller: Address, request_id: u32) {
        caller.require_auth();

        let mut req = get_redemption_request(e, request_id);
        if req.user != caller {
            panic_with_error!(e, Error::NotOperator);
        }
        if req.processed {
            panic_with_error!(e, Error::AlreadyProcessed);
        }

        // --- Effects ---
        req.processed = true; // Mark as processed so it can't be reused
        put_redemption_request(e, request_id, req.clone());

        let escrowed = get_escrowed_shares(e, &caller);
        if escrowed < req.shares {
            // Should not happen
            panic_with_error!(e, Error::InsufficientBalance);
        }

        update_user_snapshot(e, &caller);
        put_escrowed_shares(e, &caller, escrowed - req.shares);
        let bal = get_share_balance(e, &caller);
        put_share_balance(e, &caller, bal + req.shares);
        bump_balance(e, &caller);

        emit_early_redemption_cancelled(e, caller, request_id, req.shares);
        bump_instance(e);
    }

    /// Operator rejects an early redemption request and returns shares from escrow.
    pub fn reject_early_redemption(e: &Env, operator: Address, request_id: u32) {
        operator.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &operator, Role::LifecycleManager);

        let mut req = get_redemption_request(e, request_id);
        if req.processed {
            panic_with_error!(e, Error::AlreadyProcessed);
        }

        // --- Effects ---
        req.processed = true;
        put_redemption_request(e, request_id, req.clone());

        let user = req.user.clone();
        let escrowed = get_escrowed_shares(e, &user);
        if escrowed < req.shares {
            // Should not happen
            panic_with_error!(e, Error::InsufficientBalance);
        }

        update_user_snapshot(e, &user);
        put_escrowed_shares(e, &user, escrowed - req.shares);
        let bal = get_share_balance(e, &user);
        put_share_balance(e, &user, bal + req.shares);
        bump_balance(e, &user);

        emit_early_redemption_cancelled(e, user, request_id, req.shares);
        bump_instance(e);
    }

    pub fn early_redemption_fee_bps(e: &Env) -> u32 {
        get_early_redemption_fee_bps(e)
    }

    /// Set the early redemption fee (only by operator).
    pub fn set_early_redemption_fee(e: &Env, operator: Address, fee_bps: u32) {
        operator.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &operator, Role::LifecycleManager);
        require_not_closed(e);
        if fee_bps > 1000 {
            panic_with_error!(e, Error::FeeTooHigh);
        }
        put_early_redemption_fee_bps(e, fee_bps);
        emit_early_redemption_fee_set(e, fee_bps);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Access control
    // ─────────────────────────────────────────────────────────────────

    pub fn admin(e: &Env) -> Address {
        get_admin(e)
    }

    /// Grant `role` to `addr`.  Only the admin may grant roles.
    ///
    /// `FullOperator` is the backward-compatible superrole and passes every
    /// role check — equivalent to the old `set_operator(..., true)`.
    pub fn grant_role(e: &Env, caller: Address, addr: Address, role: Role) {
        caller.require_auth();
        require_admin(e, &caller);
        put_role(e, addr.clone(), role.clone(), true);
        emit_role_granted(e, addr, role);
        bump_instance(e);
    }

    /// Revoke `role` from `addr`.  Only the admin may revoke roles.
    pub fn revoke_role(e: &Env, caller: Address, addr: Address, role: Role) {
        caller.require_auth();
        require_admin(e, &caller);
        put_role(e, addr.clone(), role.clone(), false);
        emit_role_revoked(e, addr, role);
        bump_instance(e);
    }

    /// Returns `true` when `addr` holds `role`, the `FullOperator` superrole,
    /// or is the admin.
    pub fn has_role(e: &Env, addr: Address, role: Role) -> bool {
        if addr == get_admin(e) {
            return true;
        }
        get_role(e, &addr, Role::FullOperator) || get_role(e, &addr, role)
    }

    /// Backward-compatible: grants or revokes the `FullOperator` superrole.
    /// Prefer `grant_role` / `revoke_role` for new integrations.
    pub fn set_operator(e: &Env, caller: Address, operator: Address, status: bool) {
        caller.require_auth();
        require_admin(e, &caller);
        put_operator(e, operator.clone(), status);
        emit_operator_updated(e, operator, status);
        bump_instance(e);
    }

    /// Backward-compatible: returns `true` when `account` holds `FullOperator`.
    pub fn is_operator(e: &Env, account: Address) -> bool {
        get_operator(e, &account)
    }

    pub fn transfer_admin(e: &Env, caller: Address, new_admin: Address) {
        caller.require_auth();
        require_admin(e, &caller);
        let old_admin = get_admin(e);
        put_admin(e, new_admin.clone());
        emit_admin_transferred(e, old_admin, new_admin);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Blacklist
    // ─────────────────────────────────────────────────────────────────

    pub fn set_blacklisted(e: &Env, caller: Address, address: Address, status: bool) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        put_blacklisted(e, &address, status);
        emit_address_blacklisted(e, address, status);
        bump_instance(e);
    }

    pub fn is_blacklisted(e: &Env, address: Address) -> bool {
        get_blacklisted(e, &address)
    }

    // ─────────────────────────────────────────────────────────────────
    // Transfer KYC gate
    // ─────────────────────────────────────────────────────────────────

    /// Returns true when share transfers require the recipient to pass KYC.
    pub fn transfer_requires_kyc(e: &Env) -> bool {
        get_transfer_requires_kyc(e)
    }

    /// Toggle the transfer KYC requirement.  Only the admin may change this.
    pub fn set_transfer_requires_kyc(e: &Env, caller: Address, enabled: bool) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        put_transfer_requires_kyc(e, enabled);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Emergency
    // ─────────────────────────────────────────────────────────────────

    pub fn pause(e: &Env, caller: Address, reason: String) {
        caller.require_auth();
        // TreasuryManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::TreasuryManager);
        put_paused(e, true);
        put_freeze_flags(e, Self::FREEZE_ALL);
        emit_emergency_action(e, true, reason);
        bump_instance(e);
    }

    /// Re-enable vault operations.
    ///
    /// Requires admin authorization. While operators can pause the vault for
    /// rapid incident response, unpausing requires higher authority to ensure
    /// the security incident has been fully resolved.
    pub fn unpause(e: &Env, caller: Address) {
        caller.require_auth();
        require_admin(e, &caller);
        put_paused(e, false);
        put_freeze_flags(e, 0u32);
        emit_emergency_action(e, false, String::from_str(e, ""));
        bump_instance(e);
    }

    pub fn paused(e: &Env) -> bool {
        get_paused(e)
    }

    pub fn freeze_flags(e: &Env) -> u32 {
        get_freeze_flags(e)
    }

    pub fn set_freeze_flags(e: &Env, caller: Address, flags: u32) {
        caller.require_auth();
        // TreasuryManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::TreasuryManager);
        put_freeze_flags(e, flags);
        bump_instance(e);
    }

    /// Drain all vault assets to `recipient` and pause the vault.
    ///
    /// If no multi-sig signers are configured, falls back to single-admin
    /// behaviour (TreasuryManager or admin required).  When multi-sig is
    /// configured this function panics — use `propose_emergency_withdraw` /
    /// `approve_emergency_withdraw` / `execute_emergency_withdraw` instead.
    ///
    /// Security: follows CEI — the vault is paused (Effect) before the asset
    /// transfer (Interaction) so that any reentrant call is rejected by
    /// `require_not_paused`.  Reentrancy lock provides an additional hard stop.
    pub fn emergency_withdraw(e: &Env, caller: Address, recipient: Address) {
        caller.require_auth();
        // --- Checks ---
        acquire_lock(e);

        // If multi-sig is configured, single-key path is disabled.
        if get_emergency_signers(e).is_some() {
            release_lock(e);
            panic_with_error!(e, Error::NotSupported);
        }

        // TreasuryManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::TreasuryManager);

        let balance = asset_balance_of_vault(e);

        // --- Effects (pause before transferring) ---
        put_paused(e, true);
        put_freeze_flags(e, Self::FREEZE_ALL);
        emit_emergency_action(
            e,
            true,
            String::from_str(e, "Emergency withdrawal executed"),
        );

        // --- Interaction ---
        if balance > 0 {
            transfer_asset_from_vault(e, &recipient, balance);
        }
        bump_instance(e);
        release_lock(e);
    }

    /// Configure the multi-sig signer set and approval threshold for
    /// emergency withdrawals.  Admin-only.
    ///
    /// Setting signers to an empty vec clears the multi-sig configuration and
    /// re-enables the single-admin `emergency_withdraw` fallback.
    pub fn set_emergency_signers(e: &Env, caller: Address, signers: Vec<Address>, threshold: u32) {
        caller.require_auth();
        require_admin(e, &caller);

        if signers.is_empty() {
            // Clear multi-sig; restore single-admin fallback.
            remove_emergency_signers(e);
            remove_emergency_threshold(e);
            bump_instance(e);
            return;
        }

        if threshold == 0 || threshold > signers.len() {
            panic_with_error!(e, Error::InvalidThreshold);
        }

        put_emergency_signers(e, signers);
        put_emergency_threshold(e, threshold);
        bump_instance(e);
    }

    /// Any configured emergency signer may propose a withdrawal to `recipient`.
    /// Returns the new proposal ID.
    pub fn propose_emergency_withdraw(e: &Env, caller: Address, recipient: Address) -> u32 {
        caller.require_auth();
        require_emergency_signer(e, &caller);

        let proposal_id = increment_emergency_proposal_counter(e);
        let proposal = EmergencyProposal {
            recipient: recipient.clone(),
            proposed_at: e.ledger().timestamp(),
            executed: false,
        };
        put_emergency_proposal(e, proposal_id, proposal);

        // Proposer implicitly approves.
        let mut approvals: Vec<Address> = Vec::new(e);
        approvals.push_back(caller.clone());
        put_emergency_proposal_approvals(e, proposal_id, approvals);

        emit_emergency_proposed(e, proposal_id, caller, recipient);
        bump_instance(e);
        proposal_id
    }

    /// A configured emergency signer approves proposal `proposal_id`.
    pub fn approve_emergency_withdraw(e: &Env, caller: Address, proposal_id: u32) {
        caller.require_auth();
        require_emergency_signer(e, &caller);

        let proposal = get_emergency_proposal(e, proposal_id)
            .unwrap_or_else(|| panic_with_error!(e, Error::ProposalNotFound));

        if proposal.executed {
            panic_with_error!(e, Error::ProposalAlreadyExecuted);
        }

        let now = e.ledger().timestamp();
        if now > proposal.proposed_at + Self::EMERGENCY_PROPOSAL_TIMEOUT {
            panic_with_error!(e, Error::ProposalExpired);
        }

        let mut approvals = get_emergency_proposal_approvals(e, proposal_id);
        // Ensure no double-approval.
        for i in 0..approvals.len() {
            if approvals.get(i).unwrap() == caller {
                panic_with_error!(e, Error::AlreadyApproved);
            }
        }

        approvals.push_back(caller.clone());
        let count = approvals.len();
        put_emergency_proposal_approvals(e, proposal_id, approvals);

        emit_emergency_approved(e, proposal_id, caller, count);
        bump_instance(e);
    }

    /// Execute proposal `proposal_id` once the approval threshold is met.
    /// Any signer may call this; the proposal must not be expired or already executed.
    pub fn execute_emergency_withdraw(e: &Env, caller: Address, proposal_id: u32) {
        caller.require_auth();
        require_emergency_signer(e, &caller);
        acquire_lock(e);

        let mut proposal = get_emergency_proposal(e, proposal_id)
            .unwrap_or_else(|| panic_with_error!(e, Error::ProposalNotFound));

        if proposal.executed {
            release_lock(e);
            panic_with_error!(e, Error::ProposalAlreadyExecuted);
        }

        let now = e.ledger().timestamp();
        if now > proposal.proposed_at + Self::EMERGENCY_PROPOSAL_TIMEOUT {
            release_lock(e);
            panic_with_error!(e, Error::ProposalExpired);
        }

        let approvals = get_emergency_proposal_approvals(e, proposal_id);
        let threshold = get_emergency_threshold(e);
        if approvals.len() < threshold {
            release_lock(e);
            panic_with_error!(e, Error::ThresholdNotMet);
        }

        // Mark executed before transferring (CEI pattern).
        proposal.executed = true;
        put_emergency_proposal(e, proposal_id, proposal.clone());

        let balance = asset_balance_of_vault(e);

        // --- Effects ---
        put_paused(e, true);
        put_freeze_flags(e, Self::FREEZE_ALL);

        // --- Interaction ---
        if balance > 0 {
            transfer_asset_from_vault(e, &proposal.recipient, balance);
        }

        emit_emergency_executed(e, proposal_id, proposal.recipient, balance);
        bump_instance(e);
        release_lock(e);
    }

    /// Enable emergency pro-rata distribution mode.
    ///
    /// This transitions the vault to the Emergency state, snapshots the current
    /// vault balance and total supply, and allows each user to individually
    /// claim their proportional share of remaining assets.
    ///
    /// Admin-only. Once enabled, users call `emergency_claim` to withdraw.
    pub fn emergency_enable_pro_rata(e: &Env, caller: Address) {
        caller.require_auth();
        acquire_lock(e);
        require_admin(e, &caller);

        let balance = asset_balance_of_vault(e);
        let supply = get_total_supply(e);

        if supply == 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        let old_state = get_vault_state(e);
        put_vault_state(e, VaultState::Emergency);
        put_emergency_balance(e, balance);
        put_emergency_total_supply_snapshot(e, supply);
        put_paused(e, true);

        emit_vault_state_changed(e, old_state, VaultState::Emergency);
        emit_emergency_mode_enabled(e, balance, supply);
        bump_instance(e);
        release_lock(e);
    }

    /// Claim pro-rata share of vault assets in Emergency state.
    ///
    /// Each user can call this once to receive: emergency_balance * user_shares / total_supply_snapshot
    /// Shares are burned upon claiming.
    pub fn emergency_claim(e: &Env, caller: Address) -> i128 {
        caller.require_auth();
        acquire_lock(e);

        if get_vault_state(e) != VaultState::Emergency {
            panic_with_error!(e, Error::NotInEmergency);
        }
        if get_has_claimed_emergency(e, &caller) {
            panic_with_error!(e, Error::AlreadyClaimedEmergency);
        }

        let user_shares = get_share_balance(e, &caller);
        if user_shares == 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        let emergency_balance = get_emergency_balance(e);
        let total_supply_snapshot = get_emergency_total_supply_snapshot(e);

        let claim_amount = (emergency_balance * user_shares) / total_supply_snapshot;

        put_has_claimed_emergency(e, &caller, true);
        _burn(e, &caller, user_shares);

        if claim_amount > 0 {
            transfer_asset_from_vault(e, &caller, claim_amount);
        }

        emit_emergency_claimed(e, caller, claim_amount);
        bump_instance(e);
        release_lock(e);
        claim_amount
    }

    /// View function: calculate a user's pending emergency claim amount.
    pub fn pending_emergency_claim(e: &Env, user: Address) -> i128 {
        if get_vault_state(e) != VaultState::Emergency {
            return 0;
        }
        if get_has_claimed_emergency(e, &user) {
            return 0;
        }

        let user_shares = get_share_balance(e, &user);
        if user_shares == 0 {
            return 0;
        }

        let emergency_balance = get_emergency_balance(e);
        let total_supply_snapshot = get_emergency_total_supply_snapshot(e);

        if total_supply_snapshot == 0 {
            return 0;
        }

        (emergency_balance * user_shares) / total_supply_snapshot
    }

    // ─────────────────────────────────────────────────────────────────
    // Versioning and migration
    // ─────────────────────────────────────────────────────────────────

    /// Admin-only migration entry point. Updates storage schema to the latest version.
    /// Emits DataMigrated event. No-op if already up-to-date.
    pub fn migrate(e: &Env, caller: Address) {
        caller.require_auth();
        require_admin(e, &caller);

        let old_version = get_storage_schema_version(e);
        if old_version >= CURRENT_SCHEMA_VERSION {
            // Already up-to-date; no-op
            return;
        }

        crate::migrations::run_migrations(e, old_version);
        emit_data_migrated(e, old_version, CURRENT_SCHEMA_VERSION);
        bump_instance(e);
    }

    /// Returns the current storage schema version.
    pub fn storage_schema_version(e: &Env) -> u32 {
        get_storage_schema_version(e)
    }

    /// Returns the contract’s immutable code version.
    pub fn contract_version(e: &Env) -> u32 {
        get_contract_version(e)
    }

    pub fn asset(e: &Env) -> Address {
        get_asset(e)
    }

    pub fn current_apy(e: &Env) -> u32 {
        let ta = total_assets(e);
        let activation_ts = get_activation_timestamp(e);
        if activation_ts == 0 || ta == 0 {
            return get_expected_apy(e);
        }
        let now = e.ledger().timestamp();
        let elapsed = now.saturating_sub(activation_ts);
        if elapsed == 0 {
            return get_expected_apy(e);
        }
        let ytd = get_total_yield_distributed(e);
        if ytd == 0 {
            return get_expected_apy(e);
        }
        const SECONDS_PER_YEAR: u64 = 31_536_000;
        let numerator = (ytd as i128)
            .checked_mul(SECONDS_PER_YEAR as i128)
            .and_then(|v| v.checked_mul(10000))
            .unwrap_or(i128::MAX);
        let denominator = ta.checked_mul(elapsed as i128).unwrap_or(i128::MAX);
        if denominator == 0 || denominator == i128::MAX {
            return get_expected_apy(e);
        }
        let apy = numerator / denominator;
        if apy > u32::MAX as i128 {
            u32::MAX
        } else {
            apy as u32
        }
    }

    pub fn expected_apy(e: &Env) -> u32 {
        get_expected_apy(e)
    }
    pub fn set_funding_target(e: &Env, caller: Address, target: i128) {
        caller.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::LifecycleManager);
        put_funding_target(e, target);
        emit_funding_target_set(e, target);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // SEP-41 Token Interface (vault shares)
    // ─────────────────────────────────────────────────────────────────

    pub fn allowance(e: &Env, from: Address, spender: Address) -> i128 {
        get_share_allowance(e, &from, &spender)
    }

    pub fn approve(e: &Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();
        // SEP-41 §3.4: expiration_ledger must be ≥ current ledger sequence.
        // Allowing a zero amount with a past expiry is the canonical way to
        // revoke an allowance, so we only reject future-expiry cases where
        // amount > 0 and the ledger has already passed.
        if amount > 0 && expiration_ledger < e.ledger().sequence() {
            panic_with_error!(e, Error::InvalidVaultState);
        }
        put_share_allowance_with_expiry(e, &from, &spender, amount, expiration_ledger);
        emit_approval(e, from, spender, amount, expiration_ledger);
        bump_instance(e);
    }

    pub fn balance(e: &Env, id: Address) -> i128 {
        get_share_balance(e, &id)
    }

    pub fn escrowed_balance(e: &Env, id: Address) -> i128 {
        get_escrowed_shares(e, &id)
    }

    pub fn transfer(e: &Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        require_not_blacklisted(e, &from);
        require_not_blacklisted(e, &to);
        if get_transfer_requires_kyc(e) {
            require_kyc_verified(e, &to);
        }
        update_user_snapshot(e, &from);
        update_user_snapshot(e, &to);
        spend_share_balance(e, &from, amount);
        receive_share_balance(e, &to, amount);
        emit_transfer(e, from, to, amount);
        bump_instance(e);
    }

    pub fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        require_not_blacklisted(e, &spender);
        require_not_blacklisted(e, &from);
        require_not_blacklisted(e, &to);
        if get_transfer_requires_kyc(e) {
            require_kyc_verified(e, &to);
        }
        update_user_snapshot(e, &from);
        update_user_snapshot(e, &to);
        let allowance = get_share_allowance(e, &from, &spender);
        if allowance < amount {
            panic_with_error!(e, Error::InsufficientAllowance);
        }
        put_share_allowance(e, &from, &spender, allowance - amount);
        spend_share_balance(e, &from, amount);
        receive_share_balance(e, &to, amount);
        emit_transfer(e, from, to, amount);
        bump_instance(e);
    }

    pub fn burn(e: &Env, from: Address, amount: i128) {
        from.require_auth();
        // Snapshot before balance change so epoch yield is attributed to pre-burn shares.
        update_user_snapshot(e, &from);
        _burn(e, &from, amount);
        emit_burn(e, from, amount);
        bump_instance(e);
    }

    pub fn burn_from(e: &Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        let allowance = get_share_allowance(e, &from, &spender);
        if allowance < amount {
            panic_with_error!(e, Error::InsufficientAllowance);
        }
        put_share_allowance(e, &from, &spender, allowance - amount);
        // Snapshot before balance change so epoch yield is attributed to pre-burn shares.
        update_user_snapshot(e, &from);
        _burn(e, &from, amount);
        emit_burn(e, from, amount);
        bump_instance(e);
    }

    pub fn decimals(e: &Env) -> u32 {
        get_share_decimals(e)
    }
    pub fn name(e: &Env) -> String {
        get_share_name(e)
    }
    pub fn symbol(e: &Env) -> String {
        get_share_symbol(e)
    }
    pub fn total_supply(e: &Env) -> i128 {
        get_total_supply(e)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn total_assets(e: &Env) -> i128 {
    get_total_deposited(e)
}

/// `convertToShares` with **floor** division: `floor(assets * totalSupply / totalAssets)`.
/// ERC-4626 deposit path rounds down (vault-favorable). Used by `max_mint` where a 0
/// result is valid; `preview_deposit` adds a dust guard on top.
fn convert_to_shares_floor(e: &Env, assets: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return assets;
    }
    math::mul_div(e, assets, supply, ta)
}

fn preview_deposit(e: &Env, assets: i128) -> i128 {
    // ERC-4626: round **down** on deposit so the user receives fewer shares than the
    // exact rational amount — protects existing LPs from dilution via rounding.
    let shares = convert_to_shares_floor(e, assets);
    if assets > 0 && shares == 0 {
        panic_with_error!(e, Error::PreviewZeroShares);
    }
    shares
}

fn preview_mint(e: &Env, shares: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return shares;
    }
    // ERC-4626: round **up** on mint so the user pays at least the fair asset amount
    // for the requested shares — vault-favorable, symmetric to deposit rounding down.
    math::mul_div_ceil(e, shares, ta, supply)
}

fn preview_withdraw(e: &Env, assets: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return assets;
    }
    // ERC-4626: round **up** on withdraw so the user burns at least the shares needed
    // to cover `assets` — vault-favorable (user cannot withdraw “too cheaply”).
    math::mul_div_ceil(e, assets, supply, ta)
}

/// `convertToAssets` with **floor** division: `floor(shares * totalAssets / totalSupply)`.
/// ERC-4626 redeem path rounds down (vault-favorable). Used by `max_withdraw` where 0 is
/// valid; `preview_redeem` adds a dust guard on top.
fn convert_to_assets_floor(e: &Env, shares: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 {
        return shares;
    }
    math::mul_div(e, shares, ta, supply)
}

fn preview_redeem(e: &Env, shares: i128) -> i128 {
    // ERC-4626: round **down** on redeem so the user receives fewer assets than the
    // exact rational amount — protects the vault from paying out extra on rounding.
    let assets = convert_to_assets_floor(e, shares);
    if shares > 0 && assets == 0 {
        panic_with_error!(e, Error::PreviewZeroAssets);
    }
    assets
}

fn asset_balance_of_vault(e: &Env) -> i128 {
    let asset = get_asset(e);
    let client = token::Client::new(e, &asset);
    client.balance(&e.current_contract_address())
}

fn transfer_asset_to_vault(e: &Env, from: &Address, amount: i128) {
    let asset = get_asset(e);
    let client = token::Client::new(e, &asset);
    client.transfer(from, &e.current_contract_address(), &amount);
}

fn transfer_asset_from_vault(e: &Env, to: &Address, amount: i128) {
    let asset = get_asset(e);
    let client = token::Client::new(e, &asset);
    client.transfer(&e.current_contract_address(), to, &amount);
}

fn _mint(e: &Env, to: &Address, amount: i128) {
    let new_bal = get_share_balance(e, to) + amount;
    put_share_balance(e, to, new_bal);
    put_total_supply(e, get_total_supply(e) + amount);
    bump_balance(e, to);
}

fn _burn(e: &Env, from: &Address, amount: i128) {
    // Defensive snapshot: ensure the user's share balance is recorded for all
    // epochs up to now BEFORE the balance decreases.  This prevents stale
    // balances from being used in yield calculations for past epochs.
    update_user_snapshot(e, from);
    let bal = get_share_balance(e, from);
    if bal < amount {
        panic_with_error!(e, Error::InsufficientBalance);
    }
    put_share_balance(e, from, bal - amount);
    put_total_supply(e, get_total_supply(e) - amount);
    bump_balance(e, from);
}

fn spend_share_balance(e: &Env, from: &Address, amount: i128) {
    let bal = get_share_balance(e, from);
    if bal < amount {
        panic_with_error!(e, Error::InsufficientBalance);
    }
    put_share_balance(e, from, bal - amount);
    bump_balance(e, from);
}

fn receive_share_balance(e: &Env, to: &Address, amount: i128) {
    let new_bal = get_share_balance(e, to) + amount;
    put_share_balance(e, to, new_bal);
    bump_balance(e, to);
}

/// Update per-epoch share snapshot for yield accounting.
fn update_user_snapshot(e: &Env, user: &Address) {
    let last_epoch = get_last_interaction_epoch(e, user);
    let current_epoch = get_current_epoch(e);
    let current_bal = get_share_balance(e, user);

    for i in (last_epoch + 1)..=current_epoch {
        if !get_has_snapshot_for_epoch(e, user, i) {
            put_user_shares_at_epoch(e, user, i, current_bal);
            put_has_snapshot_for_epoch(e, user, i, true);
        }
    }
    put_last_interaction_epoch(e, user, current_epoch);
    bump_balance(e, user);
}

fn _get_user_shares_for_epoch(e: &Env, user: &Address, epoch: u32) -> i128 {
    if get_has_snapshot_for_epoch(e, user, epoch) {
        get_user_shares_at_epoch(e, user, epoch)
    } else {
        get_share_balance(e, user)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Require that storage schema is current; panics with MigrationRequired otherwise.
/// Skipped for migrate, version, and admin functions.
fn require_current_schema(e: &Env) {
    if get_storage_schema_version(e) != CURRENT_SCHEMA_VERSION {
        panic_with_error!(e, Error::MigrationRequired);
    }
}

fn require_admin(e: &Env, caller: &Address) {
    if *caller != get_admin(e) {
        panic_with_error!(e, Error::NotAdmin);
    }
}

/// Passes when `caller` holds `role`, the `FullOperator` superrole, or is admin.
///
/// Role hierarchy (most to least privileged):
/// - Admin → always authorised
/// - FullOperator → backward-compatible superrole; passes every role check
/// - Named role → passes only the matching role check
fn require_role(e: &Env, caller: &Address, role: Role) {
    if *caller == get_admin(e) {
        return;
    }
    if get_role(e, caller, Role::FullOperator) {
        return;
    }
    if !get_role(e, caller, role) {
        panic_with_error!(e, Error::NotOperator);
    }
}

fn require_not_frozen(e: &Env, flag: u32) {
    let flags = get_freeze_flags(e);
    if (flags & flag) != 0 {
        // Reuse VaultPaused error for backwards compatibility with existing tests.
        panic_with_error!(e, Error::VaultPaused);
    }
}

fn require_kyc_verified(e: &Env, user: &Address) {
    if !SingleRWAVault::is_kyc_verified(e, user.clone()) {
        panic_with_error!(e, Error::NotKYCVerified);
    }
}

fn require_state(e: &Env, expected: VaultState) {
    let current = get_vault_state(e);
    if current != expected {
        panic_with_error!(e, Error::InvalidVaultState);
    }
}

fn require_not_closed(e: &Env) {
    if get_vault_state(e) == VaultState::Closed {
        panic_with_error!(e, Error::InvalidVaultState);
    }
}

fn require_active_or_funding(e: &Env) {
    let state = get_vault_state(e);
    if state != VaultState::Funding && state != VaultState::Active {
        panic_with_error!(e, Error::InvalidVaultState);
    }
}

/// Withdrawals and redemptions are only valid once the vault is Active
/// (investment is live) or Matured (investment has completed).  During Funding
/// no underlying has been deployed yet, and a Closed vault has been wound down.
fn require_active_or_matured(e: &Env) {
    let state = get_vault_state(e);
    if state != VaultState::Active && state != VaultState::Matured {
        panic_with_error!(e, Error::InvalidVaultState);
    }
}

fn require_not_blacklisted(e: &Env, addr: &Address) {
    if get_blacklisted(e, addr) {
        panic_with_error!(e, Error::AddressBlacklisted);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reentrancy guard helpers
// ─────────────────────────────────────────────────────────────────────────────

fn acquire_lock(e: &Env) {
    if get_locked(e) {
        panic_with_error!(e, Error::Reentrant);
    }
    put_locked(e, true);
}

fn release_lock(e: &Env) {
    put_locked(e, false);
}

/// Panics with `NotEmergencySigner` if `caller` is not in the emergency signers list.
fn require_emergency_signer(e: &Env, caller: &Address) {
    let signers =
        get_emergency_signers(e).unwrap_or_else(|| panic_with_error!(e, Error::NotEmergencySigner));
    let mut found = false;
    for i in 0..signers.len() {
        if signers.get(i).unwrap() == *caller {
            found = true;
            break;
        }
    }
    if !found {
        panic_with_error!(e, Error::NotEmergencySigner);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract as soroban_contract, contractimpl as soroban_contractimpl, testutils::Address as _,
    };

    // Minimal SEP-41 token mock for inline blacklist tests.
    #[soroban_contract]
    struct InlineToken;
    #[soroban_contractimpl]
    impl InlineToken {
        pub fn balance(e: Env, id: Address) -> i128 {
            e.storage().persistent().get(&id).unwrap_or(0i128)
        }
        pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let fb: i128 = e.storage().persistent().get(&from).unwrap_or(0);
            e.storage().persistent().set(&from, &(fb - amount));
            let tb: i128 = e.storage().persistent().get(&to).unwrap_or(0);
            e.storage().persistent().set(&to, &(tb + amount));
        }
        pub fn mint(e: Env, to: Address, amount: i128) {
            let b: i128 = e.storage().persistent().get(&to).unwrap_or(0);
            e.storage().persistent().set(&to, &(b + amount));
        }
    }

    // Always-true KYC verifier so deposits work in blacklist tests.
    #[soroban_contract]
    struct InlineKyc;
    #[soroban_contractimpl]
    impl InlineKyc {
        pub fn has_approved(_e: Env, _cooperator: Address, _user: Address) -> bool {
            true
        }
    }

    fn create_vault(e: &Env) -> (Address, Address, Address) {
        let admin = Address::generate(e);
        let asset = e.register(InlineToken, ());
        let kyc = e.register(InlineKyc, ());

        let params = InitParams {
            asset: asset.clone(),
            share_name: String::from_str(e, "Vault Share"),
            share_symbol: String::from_str(e, "vSHARE"),
            share_decimals: 7,
            admin: admin.clone(),
            zkme_verifier: kyc,
            cooperator: admin.clone(),
            funding_target: 1000_0000000,
            maturity_date: 9999999999,
            funding_deadline: 0,
            min_deposit: 1_0000000,
            max_deposit_per_user: 0,
            early_redemption_fee_bps: 100,
            rwa_name: String::from_str(e, "Test RWA"),
            rwa_symbol: String::from_str(e, "TRWA"),
            rwa_document_uri: String::from_str(e, "https://example.com/doc"),
            rwa_category: String::from_str(e, "Bonds"),
            expected_apy: 500,
        };

        let vault_addr = e.register(SingleRWAVault, (params,));
        (vault_addr, admin, asset)
    }

    #[test]
    fn test_set_blacklisted_by_admin() {
        let e = Env::default();
        e.mock_all_auths();
        let (vault_addr, admin, _asset) = create_vault(&e);
        let client = SingleRWAVaultClient::new(&e, &vault_addr);

        let user = Address::generate(&e);

        assert!(!client.is_blacklisted(&user));

        client.set_blacklisted(&admin, &user, &true);
        assert!(client.is_blacklisted(&user));

        client.set_blacklisted(&admin, &user, &false);
        assert!(!client.is_blacklisted(&user));
    }

    #[test]
    #[should_panic]
    fn test_set_blacklisted_non_admin_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let (vault_addr, _admin, _asset) = create_vault(&e);
        let client = SingleRWAVaultClient::new(&e, &vault_addr);

        let non_admin = Address::generate(&e);
        let user = Address::generate(&e);

        client.set_blacklisted(&non_admin, &user, &true);
    }

    #[test]
    #[should_panic]
    fn test_blacklisted_cannot_transfer() {
        let e = Env::default();
        e.mock_all_auths();
        let (vault_addr, admin, asset) = create_vault(&e);
        let client = SingleRWAVaultClient::new(&e, &vault_addr);
        let token_client = InlineTokenClient::new(&e, &asset);

        let depositor = Address::generate(&e);
        let recipient = Address::generate(&e);

        token_client.mint(&depositor, &100_0000000);
        client.deposit(&depositor, &10_0000000, &depositor);

        client.set_blacklisted(&admin, &depositor, &true);

        client.transfer(&depositor, &recipient, &5_0000000);
    }

    #[test]
    #[should_panic]
    fn test_cannot_transfer_to_blacklisted() {
        let e = Env::default();
        e.mock_all_auths();
        let (vault_addr, admin, asset) = create_vault(&e);
        let client = SingleRWAVaultClient::new(&e, &vault_addr);
        let token_client = InlineTokenClient::new(&e, &asset);

        let depositor = Address::generate(&e);
        let blacklisted_recipient = Address::generate(&e);

        token_client.mint(&depositor, &100_0000000);
        client.deposit(&depositor, &10_0000000, &depositor);

        client.set_blacklisted(&admin, &blacklisted_recipient, &true);

        client.transfer(&depositor, &blacklisted_recipient, &5_0000000);
    }

    #[test]
    #[should_panic]
    fn test_blacklisted_cannot_deposit() {
        let e = Env::default();
        e.mock_all_auths();
        let (vault_addr, admin, asset) = create_vault(&e);
        let client = SingleRWAVaultClient::new(&e, &vault_addr);
        let token_client = InlineTokenClient::new(&e, &asset);

        let depositor = Address::generate(&e);
        token_client.mint(&depositor, &100_0000000);

        client.set_blacklisted(&admin, &depositor, &true);

        client.deposit(&depositor, &10_0000000, &depositor);
    }
}
