#![no_std]

mod errors;
mod events;
mod math;
mod migrations;
mod storage;
mod token_interface;
mod types;

#[cfg(test)]
mod bench;
#[cfg(test)]
mod fuzz_tests;
#[cfg(test)]
mod test_access_control;
#[cfg(test)]
mod test_allowance_ttl;
#[cfg(test)]
mod test_burn_snapshot;
#[cfg(test)]
mod test_burn_yield_accounting;
#[cfg(test)]
mod test_can_redeem;
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
mod test_epoch_activity;
#[cfg(test)]
mod test_epoch_history;
#[cfg(test)]
mod test_escrow;
#[cfg(test)]
mod test_events;
#[cfg(test)]
mod test_fee_on_transfer;
#[cfg(test)]
mod test_freeze_flags;
#[cfg(test)]
mod test_funding_deadline;
#[cfg(test)]
mod test_helpers;
#[cfg(test)]
mod test_inflation_attack;
#[cfg(test)]
mod test_lifecycle;
#[cfg(test)]
mod test_multiple_deposit_times;
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
mod test_safe_preview;
#[cfg(test)]
mod test_share_price_oracle;
#[cfg(test)]
mod test_token;
#[cfg(test)]
mod test_vault_state_guards;
#[cfg(test)]
mod test_withdraw;
#[cfg(test)]
mod test_yield_vesting;
#[cfg(test)]
mod tests;

pub use crate::storage::Key;
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
const MAX_OPERATOR_PAGE_SIZE: u32 = 50;
const MAX_BLACKLIST_PAGE_SIZE: u32 = 50;

/// Virtual offset for share price inflation attack mitigation (OpenZeppelin approach).
/// Set to 10^6 to provide robust protection for 6-decimal assets like USDC.
const VIRTUAL_OFFSET: i128 = 1_000_000;

#[contractimpl]
impl SingleRWAVault {
    pub const FREEZE_DEPOSIT_MINT: u32 = 1;
    pub const FREEZE_WITHDRAW_REDEEM: u32 = 2;
    pub const FREEZE_YIELD: u32 = 4;
    pub const FREEZE_ALL: u32 =
        Self::FREEZE_DEPOSIT_MINT | Self::FREEZE_WITHDRAW_REDEEM | Self::FREEZE_YIELD;

    /// Timeout for emergency proposals: 24 hours in seconds.
    pub const EMERGENCY_PROPOSAL_TIMEOUT: u64 = 86400;
    pub const MAX_TRANSFER_EXEMPTIONS: u32 = crate::storage::MAX_TRANSFER_EXEMPTIONS;
    /// Max length (in characters) of the operator-provided funding target reason string.
    pub const MAX_FUNDING_TARGET_REASON_LEN: u32 = 64;

    // ─────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────

    /// Initialise a new Single-RWA Vault.
    ///
    /// Parameters are grouped into an `InitParams` struct because Soroban
    /// enforces a maximum of 10 arguments per contract function.
    pub fn __constructor(e: &Env, params: InitParams) {
        // --- Validation ---
        require_valid_address(e, &params.asset);
        require_valid_address(e, &params.admin);
        require_valid_address(e, &params.zkme_verifier);
        require_valid_address(e, &params.cooperator);

        if params.asset == e.current_contract_address() {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.share_decimals > 18 {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.maturity_date <= e.ledger().timestamp() {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if params.early_redemption_fee_bps > 1000 || params.operator_fee_bps > 1000 {
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
        put_operator_fee_bps(e, params.operator_fee_bps);
        put_yield_vesting_period(e, params.yield_vesting_period);

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

        // Timelock configuration
        put_timelock_delay(e, params.timelock_delay);
        put_timelock_counter(e, 0u32);

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

    /// Returns true when the user has passed KYC verification (or when no verifier is set).
    ///
    /// ## Frontend Usage
    /// This helper allows frontends to visually flag addresses and prevent actions
    /// before attempting transactions. Call this view before deposit/transfer to
    /// provide immediate feedback to users.
    ///
    /// ## Behavior
    /// - Returns `true` if `zkme_verifier` is set to the contract itself (bypass mode)
    /// - Returns `true` if the ZkMe verifier contract returns `has_approved = true`
    /// - Returns `false` otherwise
    ///
    /// # Arguments
    /// * `user` - The address to check for KYC verification status
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
    pub fn get_zkme_verifier(e: &Env) -> Address {
        get_zkme_verifier(e)
    }
    pub fn cooperator(e: &Env) -> Address {
        get_cooperator(e)
    }
    pub fn get_cooperator(e: &Env) -> Address {
        get_cooperator(e)
    }

    pub fn set_zkme_verifier(e: &Env, caller: Address, verifier: Address) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        require_valid_address(e, &verifier);
        let old = get_zkme_verifier(e);
        put_zkme_verifier(e, verifier.clone());
        emit_zkme_verifier_updated(e, caller, old, verifier);
        bump_instance(e);
    }

    pub fn set_cooperator(e: &Env, caller: Address, new_cooperator: Address) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        require_valid_address(e, &new_cooperator);
        let old = get_cooperator(e);
        put_cooperator(e, new_cooperator.clone());
        emit_cooperator_updated(e, old.clone(), new_cooperator.clone());
        // Emit additional event for cooperator fee tracking
        emit_cooperator_fee_updated(e, old, new_cooperator);
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
        require_not_blacklisted_deposit_parties(e, &caller, &receiver);
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
        let is_new_investor =
            get_share_balance(e, &receiver) == 0 && get_escrowed_shares(e, &receiver) == 0;
        update_user_snapshot(e, &receiver);
        put_user_deposited(e, &receiver, get_user_deposited(e, &receiver) + assets);
        put_total_deposited(e, get_total_deposited(e) + assets);
        _mint(e, &receiver, shares);
        record_deposit_activity(e, get_current_epoch(e), assets, is_new_investor);

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
        require_not_blacklisted_deposit_parties(e, &caller, &receiver);
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
        let is_new_investor =
            get_share_balance(e, &receiver) == 0 && get_escrowed_shares(e, &receiver) == 0;
        update_user_snapshot(e, &receiver);
        put_user_deposited(e, &receiver, get_user_deposited(e, &receiver) + assets);
        put_total_deposited(e, get_total_deposited(e) + assets);
        _mint(e, &receiver, shares);
        record_deposit_activity(e, get_current_epoch(e), assets, is_new_investor);

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
        require_not_blacklisted_withdraw_parties(e, &caller, &owner, &receiver);
        require_active_or_matured(e);
        require_positive(e, assets);

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

        let is_exiting = get_share_balance(e, &owner) == 0 && get_escrowed_shares(e, &owner) == 0;
        record_withdrawal_activity(e, get_current_epoch(e), assets, is_exiting);

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
        require_not_blacklisted_withdraw_parties(e, &caller, &owner, &receiver);
        require_active_or_matured(e);
        require_positive(e, shares);

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

        let is_exiting = get_share_balance(e, &owner) == 0 && get_escrowed_shares(e, &owner) == 0;
        record_withdrawal_activity(e, get_current_epoch(e), assets, is_exiting);

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

    /// Safe preview of shares burned to withdraw exactly `assets` (rounding **up**).
    /// Returns status code 0 on success; no panic on error conditions.
    pub fn safe_preview_withdraw(e: &Env, assets: i128) -> SafePreviewResult {
        if assets < 0 {
            return SafePreviewResult {
                amount: 0,
                status_code: Error::ZeroAmount as u32,
            };
        }
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        if supply == 0 || ta == 0 {
            return SafePreviewResult {
                amount: assets,
                status_code: 0,
            };
        }
        let shares = math::mul_div_ceil(e, assets, supply + VIRTUAL_OFFSET, ta + VIRTUAL_OFFSET);
        SafePreviewResult {
            amount: shares,
            status_code: 0,
        }
    }

    /// Safe preview of assets received when redeeming `shares` (rounding **down**).
    /// Returns status code 0 on success; no panic on error conditions.
    pub fn safe_preview_redeem(e: &Env, shares: i128) -> SafePreviewResult {
        if shares < 0 {
            return SafePreviewResult {
                amount: 0,
                status_code: Error::ZeroAmount as u32,
            };
        }
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        if supply == 0 {
            return SafePreviewResult {
                amount: shares,
                status_code: 0,
            };
        }
        let assets = math::mul_div(e, shares, ta + VIRTUAL_OFFSET, supply + VIRTUAL_OFFSET);
        if shares > 0 && assets == 0 {
            return SafePreviewResult {
                amount: 0,
                status_code: Error::PreviewZeroAssets as u32,
            };
        }
        SafePreviewResult {
            amount: assets,
            status_code: 0,
        }
    }

    /// Safe, non-panicking preview of shares minted for `assets` deposited.
    ///
    /// Validates all deposit constraints (minimum, per-user cap, funding target)
    /// before computing the share amount. Returns a typed reason on failure so
    /// that UI estimators can surface actionable messages without catching traps.
    ///
    /// # Returns
    /// - `ok == true`, `shares == estimated`, `reason == SafePreviewDepositReason::None`.
    /// - `ok == false`, `shares == 0`, `reason` identifies the violated constraint.
    pub fn safe_preview_deposit(e: &Env, assets: i128) -> SafePreviewDepositResult {
        macro_rules! fail_deposit {
            ($r:expr) => {
                return SafePreviewDepositResult {
                    ok: false,
                    shares: 0,
                    reason: $r,
                }
            };
        }

        if assets <= 0 {
            fail_deposit!(SafePreviewDepositReason::ZeroAmount);
        }

        let min_dep = get_min_deposit(e);
        if min_dep > 0 && assets < min_dep {
            fail_deposit!(SafePreviewDepositReason::BelowMinimumDeposit);
        }

        let max_dep = get_max_deposit_per_user(e);
        if max_dep > 0 && assets > max_dep {
            // Conservative: compare assets against the cap ceiling directly.
            // For per-user deposit accumulation checks, use `can_deposit_many`.
            fail_deposit!(SafePreviewDepositReason::ExceedsMaximumDeposit);
        }

        if get_vault_state(e) == VaultState::Funding {
            let target = get_funding_target(e);
            if target > 0 {
                let current = total_assets(e);
                if current + assets > target {
                    fail_deposit!(SafePreviewDepositReason::FundingTargetExceeded);
                }
            }
        }

        // Compute shares using the same formula as preview_deposit / deposit.
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        let shares = if supply == 0 || ta == 0 {
            assets
        } else {
            math::mul_div(e, assets, supply + VIRTUAL_OFFSET, ta + VIRTUAL_OFFSET)
        };

        if shares == 0 {
            fail_deposit!(SafePreviewDepositReason::ZeroShares);
        }

        SafePreviewDepositResult {
            ok: true,
            shares,
            reason: SafePreviewDepositReason::None,
        }
    }

    /// Safe, non-panicking preview of the asset cost to mint exactly `shares`.
    ///
    /// Validates all deposit constraints after computing the asset cost so that
    /// UI estimators receive a typed reason rather than a contract trap.
    ///
    /// # Returns
    /// - `ok == true`, `assets == estimated`, `reason == SafePreviewMintReason::None`.
    /// - `ok == false`, `assets == 0`, `reason` identifies the violated constraint.
    pub fn safe_preview_mint(e: &Env, shares: i128) -> SafePreviewMintResult {
        macro_rules! fail_mint {
            ($r:expr) => {
                return SafePreviewMintResult {
                    ok: false,
                    assets: 0,
                    reason: $r,
                }
            };
        }

        if shares <= 0 {
            fail_mint!(SafePreviewMintReason::ZeroAmount);
        }

        // Compute asset cost using the same formula as preview_mint / mint (ceiling division).
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        let assets = if supply == 0 || ta == 0 {
            shares
        } else {
            math::mul_div_ceil(e, shares, ta + VIRTUAL_OFFSET, supply + VIRTUAL_OFFSET)
        };

        let min_dep = get_min_deposit(e);
        if min_dep > 0 && assets < min_dep {
            fail_mint!(SafePreviewMintReason::BelowMinimumDeposit);
        }

        let max_dep = get_max_deposit_per_user(e);
        if max_dep > 0 && assets > max_dep {
            fail_mint!(SafePreviewMintReason::ExceedsMaximumDeposit);
        }

        if get_vault_state(e) == VaultState::Funding {
            let target = get_funding_target(e);
            if target > 0 {
                let current = total_assets(e);
                if current + assets > target {
                    fail_mint!(SafePreviewMintReason::FundingTargetExceeded);
                }
            }
        }

        SafePreviewMintResult {
            ok: true,
            assets,
            reason: SafePreviewMintReason::None,
        }
    }

    /// Raw underlying-token balance held by this vault contract, in base units.
    ///
    /// Unlike `total_assets()` — which returns the accounting value tracked in
    /// `TotDep` — this method queries the token contract directly. Both values
    /// should match during normal operation; any divergence indicates an
    /// out-of-band transfer or fee-on-transfer token behaviour.
    ///
    /// Wallet scripts and operator monitoring tools can use this to perform a
    /// quick solvency sanity check without computing it off-chain.
    ///
    /// # Returns
    /// The actual token balance of the vault contract address, in the asset's
    /// base units (e.g. micro-USDC for a 6-decimal USDC vault).
    pub fn vault_asset_balance(e: &Env) -> i128 {
        let asset = get_asset(e);
        let client = token::Client::new(e, &asset);
        client.balance(&e.current_contract_address())
    }

    // ERC-4626 pure conversion helpers (floor division)
    // ─────────────────────────────────────────────────────────────────

    pub fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        if supply == 0 || ta == 0 {
            return assets;
        }
        // Apply virtual offset to prevent share price inflation attack (Issue #95)
        // shares = assets * (supply + OFFSET) / (totalAssets + OFFSET) (floor)
        math::mul_div(e, assets, supply + VIRTUAL_OFFSET, ta + VIRTUAL_OFFSET)
    }

    pub fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        let supply = get_total_supply(e);
        let ta = total_assets(e);
        if supply == 0 {
            return shares;
        }
        // Apply virtual offset to prevent share price inflation attack (Issue #95)
        // assets = shares * (totalAssets + OFFSET) / (supply + OFFSET) (floor)
        math::mul_div(e, shares, ta + VIRTUAL_OFFSET, supply + VIRTUAL_OFFSET)
    }

    pub fn redemption_request(e: &Env, request_id: u32) -> RedemptionRequest {
        get_redemption_request(e, request_id)
    }

    /// Expose queue stats: pending count, oldest request timestamp/id, total requested shares.
    ///
    /// Operators can monitor backlog health without scanning every request.
    pub fn get_redemption_queue_summary(e: &Env) -> RedemptionQueueSummary {
        let total_requests = get_redemption_counter(e);
        let mut pending_count = 0u32;
        let mut oldest_request_timestamp = 0u64;
        let mut oldest_request_id = 0u32;
        let mut total_pending_shares = 0i128;

        // Redemption IDs are 1-based monotonically increasing.  We scan from 1 up
        // to `total_requests`.  Requests that have been processed are skipped.
        for i in 1..=total_requests {
            let req = get_redemption_request(e, i); // This panics if ID invalid, but we stay in bounds.
            if !req.processed {
                if pending_count == 0 {
                    oldest_request_timestamp = req.request_time;
                    oldest_request_id = i;
                }
                pending_count += 1;
                total_pending_shares += req.shares;
            }
        }

        RedemptionQueueSummary {
            pending_count,
            oldest_request_timestamp,
            oldest_request_id,
            total_pending_shares,
        }
    }

    /// Returns the ID that will be assigned to the next early redemption request.
    ///
    /// This is useful for frontends and indexers to predict the next request ID
    /// without calling `request_early_redemption`.
    ///
    /// Note: Redemption IDs are 1-based and monotonically increasing.
    pub fn next_redemption_request_id(e: &Env) -> u32 {
        get_redemption_counter(e) + 1
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

    /// Returns the remaining deposit capacity for `user` based on current
    /// cumulative deposits and max cap.
    ///
    /// This lets frontends enforce limits before sending transactions.
    ///
    /// # Returns
    /// - `cap - already_deposited` if cap > 0.
    /// - `i128::MAX` if cap is 0 (unlimited).
    pub fn max_deposit_headroom(e: &Env, user: Address) -> i128 {
        let cap = get_max_deposit_per_user(e);
        if cap == 0 {
            return i128::MAX;
        }
        let already = get_user_deposited(e, &user);
        (cap - already).max(0)
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

    /// Batch redemption preflight check for multiple users.
    ///
    /// Returns per-user redemption feasibility with asset conversion preview.
    /// This improves operator planning for coordinated redemptions.
    ///
    /// For each user, checks:
    /// - Vault state (must be Active or Matured)
    /// - User is not blacklisted
    /// - User has sufficient share balance
    /// - Computes asset output via preview_redeem
    ///
    /// Maximum batch size is 100 users to prevent excessive iteration.
    /// Returns a vector of RedemptionPreflight results, one per user.
    pub fn can_redeem_many(
        e: &Env,
        users: Vec<Address>,
        shares: Vec<i128>,
    ) -> Vec<RedemptionPreflight> {
        const MAX_BATCH_SIZE: u32 = 100;

        // Validate inputs
        if users.len() != shares.len() {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if users.len() > MAX_BATCH_SIZE {
            panic_with_error!(e, Error::InvalidInitParams);
        }

        let mut results: Vec<RedemptionPreflight> = Vec::new(e);

        // Check vault state once
        let paused = get_paused(e);
        let state = get_vault_state(e);
        let can_redeem_state =
            !paused && (state == VaultState::Active || state == VaultState::Matured);

        for i in 0..users.len() {
            let user = users.get_unchecked(i);
            let requested_shares = shares.get_unchecked(i);

            let mut can_redeem = false;
            let mut reason = String::from_str(e, "");
            let mut assets_out = 0i128;

            // Check vault state
            if !can_redeem_state {
                reason = if paused {
                    String::from_str(e, "vault_paused")
                } else {
                    String::from_str(e, "invalid_vault_state")
                };
            }
            // Check if user is blacklisted
            else if get_blacklisted(e, &user) {
                reason = String::from_str(e, "user_blacklisted");
            }
            // Check if shares amount is valid
            else if requested_shares <= 0 {
                reason = String::from_str(e, "zero_or_negative_shares");
            }
            // Check user balance
            else {
                let user_balance = get_share_balance(e, &user);
                if user_balance < requested_shares {
                    reason = String::from_str(e, "insufficient_balance");
                } else {
                    // All checks passed
                    can_redeem = true;
                    assets_out = preview_redeem(e, requested_shares);
                }
            }

            results.push_back(RedemptionPreflight {
                user: user.clone(),
                shares: requested_shares,
                assets_out,
                can_redeem,
                reason,
            });
        }
        results
    }
    /// Batched deposit preflight check (bounded to avoid expensive calls).
    /// Returns per-user deposit validation results with status codes and expected shares.
    /// Max batch size: 50 entries per call.
    pub fn can_deposit_many(
        e: &Env,
        users: Vec<Address>,
        amounts: Vec<i128>,
    ) -> Vec<DepositCheckResult> {
        const MAX_BATCH: u32 = 50;
        let mut results: Vec<DepositCheckResult> = Vec::new(e);

        #[allow(clippy::unnecessary_cast)]
        let actual_len = users.len().min(amounts.len()) as u32;
        if actual_len == 0 {
            return results;
        }

        let capped = actual_len.min(MAX_BATCH);
        if get_paused(e) {
            for i in 0..capped {
                let user = users.get_unchecked(i);
                results.push_back(DepositCheckResult {
                    user,
                    status_code: Error::VaultPaused as u32,
                    expected_shares: 0,
                });
            }
            return results;
        }

        let state = get_vault_state(e);
        if state != VaultState::Funding && state != VaultState::Active {
            for i in 0..capped {
                let user = users.get_unchecked(i);
                results.push_back(DepositCheckResult {
                    user,
                    status_code: Error::InvalidVaultState as u32,
                    expected_shares: 0,
                });
            }
            return results;
        }

        let min_dep = get_min_deposit(e);
        let max_dep = get_max_deposit_per_user(e);
        let target = get_funding_target(e);
        let mut current_total = total_assets(e);

        for i in 0..capped {
            let user = users.get_unchecked(i);
            let assets = amounts.get_unchecked(i);

            let mut status_code = 0u32;

            if assets < min_dep {
                status_code = Error::BelowMinimumDeposit as u32;
            } else if max_dep > 0 {
                let already = get_user_deposited(e, &user);
                if already + assets > max_dep {
                    status_code = Error::ExceedsMaximumDeposit as u32;
                }
            }

            if status_code == 0
                && state == VaultState::Funding
                && target > 0
                && current_total + assets > target
            {
                status_code = Error::FundingTargetExceeded as u32;
            }

            let expected_shares = if status_code == 0 {
                let shares = preview_deposit(e, assets);
                if shares == 0 {
                    status_code = Error::PreviewZeroShares as u32;
                }
                shares
            } else {
                0
            };

            results.push_back(DepositCheckResult {
                user,
                status_code,
                expected_shares,
            });

            if status_code == 0 && state == VaultState::Funding && target > 0 {
                current_total += assets;
            }
        }

        results
    }

    /// Returns the share balance of a user at a specific epoch.
    ///
    /// This enables UIs to build per-epoch claim mechanics and determine which
    /// epochs have already been claimed. Returns the snapshot balance taken at
    /// the end of the given epoch. If the snapshot does not exist, returns 0.
    ///
    /// Used by claim-tracking UIs to disable "Claim" buttons for already-claimed epochs.
    pub fn user_shares_at_epoch(e: &Env, user: Address, epoch: u32) -> i128 {
        get_user_shares_at_epoch(e, &user, epoch)
    }

    /// Check if a single user can deposit a given amount without mutation.
    ///
    /// Returns explicit reason codes for UIs to show human-friendly error messages.
    /// Checks KYC status (if applicable), minimum deposit, per-user deposit limit,
    /// funding target, and vault state. Gas cost is minimal.
    ///
    /// Status codes:
    /// - 0: deposit allowed, check `expected_shares`
    /// - Non-zero: error code (e.g., BelowMinimumDeposit = 6, ExceedsMaximumDeposit = 7)
    pub fn can_deposit(e: &Env, user: Address, amount: i128) -> DepositCheckResult {
        let users = Vec::from_array(e, [user.clone()]);
        let amounts = Vec::from_array(e, [amount]);
        let results = Self::can_deposit_many(e, users, amounts);

        if !results.is_empty() {
            results.get_unchecked(0)
        } else {
            DepositCheckResult {
                user,
                status_code: 0,
                expected_shares: 0,
            }
        }
    }

    /// Check if a user can withdraw a given asset amount without mutation.
    ///
    /// Returns explicit reason codes for callers to show human-friendly messages.
    /// Checks KYC status, vault state, and user balance. Does not check deposit limits.
    /// Returns status code 0 if withdrawal is allowed; non-zero indicates failure reason.
    pub fn can_withdraw(e: &Env, user: Address, assets: i128) -> u32 {
        if get_paused(e) {
            return Error::VaultPaused as u32;
        }

        let state = get_vault_state(e);
        if state != VaultState::Active && state != VaultState::Matured {
            return Error::InvalidVaultState as u32;
        }

        if !Self::is_kyc_verified(e, user.clone()) {
            return Error::NotKYCVerified as u32;
        }

        let share_balance = get_share_balance(e, &user);
        if share_balance == 0 {
            return Error::InsufficientBalance as u32;
        }

        let convertible = convert_to_assets_floor(e, share_balance);
        if convertible < assets {
            return Error::InsufficientBalance as u32;
        }

        0
    }

    /// Returns the total assets currently held or controlled by the vault.
    ///
    /// This is the sum of all user deposits net of withdrawals, before
    /// distributions and early redemption escrows. It does **not** include
    /// unclaimed epoch yields; those are computed separately via `claim_yield`.
    ///
    /// # Value Representation
    /// The returned value is in the vault's underlying asset token units
    /// (e.g., USDC). For decimals, use the asset's token standard definition
    /// (typically 6 or 18 decimals depending on the underlying asset).
    ///
    /// # Off-Chain Calculations
    /// When computing share price off-chain (`share_price = total_assets / total_supply`),
    /// ensure both values use the same decimals (scale `total_assets` by
    /// `10^share_decimals` for accuracy).
    ///
    /// # See Also
    /// - `total_supply()`: Returns the total outstanding vault shares
    /// - `share_price()`: Pre-computed share price scaled by `10^share_decimals`
    pub fn total_assets(e: &Env) -> i128 {
        total_assets(e)
    }

    // ─────────────────────────────────────────────────────────────────
    // Share-price oracle views (#119)
    //
    // External integrators (lending markets, DEXs, NAV reporters) can read
    // the live share price without computing the ratio off-chain.  Historical
    // price is available per epoch via `price_per_share_history`.
    // ─────────────────────────────────────────────────────────────────

    /// Live share price scaled by `10^share_decimals`.
    /// Returns `10^share_decimals` (par) when `total_supply == 0`.
    pub fn share_price(e: &Env) -> i128 {
        let decimals = get_share_decimals(e);
        Self::share_price_with_precision(e, decimals)
    }

    /// Live share price scaled by `10^precision`. Returns `10^precision` (par)
    /// when `total_supply == 0`. Caps `precision` at 18 to keep `pow` bounded
    /// and the result within `i128`.
    pub fn share_price_with_precision(e: &Env, precision: u32) -> i128 {
        let p = if precision > 18 { 18 } else { precision };
        let scale: i128 = 10i128.pow(p);
        let supply = get_total_supply(e);
        if supply == 0 {
            return scale;
        }
        math::mul_div(e, total_assets(e), scale, supply)
    }

    /// Returns `(total_assets, total_supply)` for callers that prefer to
    /// compute the ratio themselves (e.g. with their own scaling or rounding).
    pub fn exchange_rate(e: &Env) -> (i128, i128) {
        (total_assets(e), get_total_supply(e))
    }

    /// Net Asset Value per share. Alias for `share_price` named for traditional
    /// finance integrators.
    pub fn nav_per_share(e: &Env) -> i128 {
        Self::share_price(e)
    }

    /// Share price at a specific epoch, scaled by `10^share_decimals`.
    /// Reads the `(total_assets, total_supply)` pair snapshotted by
    /// `distribute_yield`. Returns `0` for epochs with no recorded supply.
    pub fn price_per_share_history(e: &Env, epoch: u32) -> i128 {
        let supply = get_epoch_total_shares(e, epoch);
        if supply == 0 {
            return 0;
        }
        let assets = get_epoch_total_assets(e, epoch);
        let scale: i128 = 10i128.pow(get_share_decimals(e));
        math::mul_div(e, assets, scale, supply)
    }

    // ─────────────────────────────────────────────────────────────────
    // Versioning
    // ─────────────────────────────────────────────────────────────────

    pub fn version(e: &Env) -> u32 {
        get_contract_version(e)
    }

    pub fn storage_schema_version(e: &Env) -> u32 {
        get_storage_schema_version(e)
    }

    /// Provide a lightweight capability check endpoint for major function groups (#299).
    pub fn supports_interface(_e: &Env, id: u32) -> bool {
        matches!(
            id,
            INTERFACE_BASE
                | INTERFACE_VAULT_ERC4626
                | INTERFACE_YIELD_ACCOUNTING
                | INTERFACE_EARLY_REDEMPTION
                | INTERFACE_RBAC
                | INTERFACE_TIMELOCK
                | INTERFACE_EMERGENCY
                | INTERFACE_ACTIVITY_TRACKING
        )
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
        require_positive(e, amount);

        // Guard against yield loss when no shareholders exist (Issue #97)
        let total_supply = get_total_supply(e);
        if total_supply == 0 {
            panic_with_error!(e, Error::NoShareholders);
        }

        // --- Effects (state changes before external call) ---
        let epoch = get_current_epoch(e) + 1;
        put_current_epoch(e, epoch);
        put_epoch_yield(e, epoch, amount);
        put_epoch_total_shares(e, epoch, total_supply);
        put_epoch_timestamp(e, epoch, e.ledger().timestamp());
        put_total_yield_distributed(e, get_total_yield_distributed(e) + amount);
        let new_total_deposited = get_total_deposited(e) + amount;
        put_total_deposited(e, new_total_deposited);
        // Snapshot total_assets at this epoch for the share-price oracle (#119).
        put_epoch_total_assets(e, epoch, new_total_deposited);

        emit_yield_distributed(e, epoch, amount, e.ledger().timestamp());

        // --- Interaction (pull yield tokens into vault last) ---
        transfer_asset_to_vault(e, &caller, amount);

        bump_instance(e);
        release_lock(e);
        epoch
    }

    /// Returns the amount of unclaimed yield remaining for a specific epoch.
    /// Useful for operator dashboards to track yield distribution status.
    pub fn get_unclaimed_yield(e: &Env, epoch: u32) -> i128 {
        let total_yield = get_epoch_yield(e, epoch);
        if total_yield == 0 {
            return 0;
        }
        // Note: This is an approximation. Exact tracking would require
        // iterating all users, which is not feasible on-chain.
        // Operators should use off-chain indexing for precise tracking.
        total_yield
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
        record_yield_claim_activity(e, epoch, amount);
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

        let amount = Self::pending_yield_for_epoch(e, caller.clone(), epoch);
        if amount <= 0 {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        // --- Effects ---
        // Update the amount claimed for this specific epoch
        let already_claimed = get_user_epoch_yield_claimed(e, &caller, epoch);
        put_user_epoch_yield_claimed(e, &caller, epoch, already_claimed + amount);

        // Check if this epoch is now fully claimed
        let total_yield_for_user = {
            let user_shares = _get_user_shares_for_epoch(e, &caller, epoch);
            let total_shares = get_epoch_total_shares(e, epoch);
            if total_shares == 0 || user_shares == 0 {
                0
            } else {
                math::mul_div(e, get_epoch_yield(e, epoch), user_shares, total_shares)
            }
        };

        let new_total_claimed = already_claimed + amount;
        if new_total_claimed >= total_yield_for_user {
            // Epoch is fully claimed - mark as claimed for cursor optimization
            put_has_claimed_epoch(e, &caller, epoch, true);

            // Advance the cursor: if this epoch is the next sequential one after
            // the cursor, walk forward over any already-claimed epochs too.
            let mut cursor = get_last_claimed_epoch(e, &caller);
            let current = get_current_epoch(e);
            while cursor < current && get_has_claimed_epoch(e, &caller, cursor + 1) {
                cursor += 1;
            }
            put_last_claimed_epoch(e, &caller, cursor);
        }

        put_total_yield_claimed(e, &caller, get_total_yield_claimed(e, &caller) + amount);
        record_yield_claim_activity(e, get_current_epoch(e), amount);
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

    /// Return a bounded, per-epoch pending-yield breakdown for wallet UIs.
    ///
    /// Ordered by ascending epoch, starting from `last_claimed_epoch + 1`, and
    /// includes at most `max_epochs` entries (capped at 50).
    pub fn pending_yield_breakdown(
        e: &Env,
        user: Address,
        max_epochs: u32,
    ) -> Vec<PendingYieldEpoch> {
        const MAX_EPOCHS: u32 = 50;
        let cap = max_epochs.min(MAX_EPOCHS);
        let mut out: Vec<PendingYieldEpoch> = Vec::new(e);
        if cap == 0 {
            return out;
        }

        let cur = get_current_epoch(e);
        let start = get_last_claimed_epoch(e, &user) + 1;
        for epoch in start..=cur {
            if out.len() >= cap {
                break;
            }
            if get_has_claimed_epoch(e, &user, epoch) {
                continue;
            }
            let pending = Self::pending_yield_for_epoch(e, user.clone(), epoch);
            if pending > 0 {
                out.push_back(PendingYieldEpoch { epoch, pending });
            }
        }
        out
    }

    /// Non-binding heuristic for the loop work `claim_yield(user)` may do.
    pub fn estimate_claim_cost_hint(e: &Env, user: Address) -> ClaimCostHint {
        let current_epoch = get_current_epoch(e);
        let last_claimed_epoch = get_last_claimed_epoch(e, &user);
        let epochs_scanned = current_epoch.saturating_sub(last_claimed_epoch);

        let mut unclaimed_epochs = 0u32;
        if epochs_scanned > 0 {
            for epoch in (last_claimed_epoch + 1)..=current_epoch {
                if !get_has_claimed_epoch(e, &user, epoch) {
                    unclaimed_epochs += 1;
                }
            }
        }

        ClaimCostHint {
            current_epoch,
            last_claimed_epoch,
            epochs_scanned,
            unclaimed_epochs,
        }
    }

    /// Preview claimable yield for a bounded epoch range without mutating claim flags.
    pub fn preview_claim_yield_range(
        e: &Env,
        user: Address,
        start: u32,
        end: u32,
    ) -> ClaimYieldRangePreview {
        require_current_schema(e);
        let current = get_current_epoch(e);
        if start == 0 || start > end || end > current {
            panic_with_error!(e, Error::InvalidEpochRange);
        }
        if end - start + 1 > 50 {
            panic_with_error!(e, Error::InvalidEpochRange);
        }

        let mut total: i128 = 0;
        for epoch in start..=end {
            total += Self::pending_yield_for_epoch(e, user.clone(), epoch);
        }

        ClaimYieldRangePreview {
            claimable_yield: total,
            epochs_scanned: end - start + 1,
        }
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

        // Calculate total yield for user in this epoch
        let total_yield_for_user =
            math::mul_div(e, get_epoch_yield(e, epoch), user_shares, total_shares);

        // Get vesting period (0 = instant claiming for backward compatibility)
        let vesting_period = get_yield_vesting_period(e);
        if vesting_period == 0 {
            // No vesting - return full amount
            return total_yield_for_user;
        }

        // Get when this epoch was distributed
        let epoch_timestamp = get_epoch_timestamp(e, epoch);
        if epoch_timestamp == 0 {
            // Epoch timestamp not set (shouldn't happen with proper initialization)
            return total_yield_for_user;
        }

        // Calculate vested portion
        let now = e.ledger().timestamp();
        if now <= epoch_timestamp {
            // Distribution just happened - nothing vested yet
            return 0;
        }

        let elapsed = now - epoch_timestamp;
        let vested_fraction = if elapsed >= vesting_period {
            // Fully vested
            1_000_000_000 // Use 1e9 for precision
        } else {
            // Partially vested - use integer math: (elapsed * 1e9) / vesting_period
            (elapsed * 1_000_000_000) / vesting_period
        };

        // Calculate vested amount: (total_yield * vested_fraction) / 1e9
        let vested_amount = (total_yield_for_user * vested_fraction as i128) / 1_000_000_000i128;

        // Subtract already claimed amount for this epoch
        let already_claimed = get_user_epoch_yield_claimed(e, &user, epoch);
        if vested_amount <= already_claimed {
            return 0;
        }

        vested_amount - already_claimed
    }

    pub fn current_epoch(e: &Env) -> u32 {
        get_current_epoch(e)
    }
    /// Alias getter for integrations expecting `get_*` naming.
    pub fn get_current_epoch(e: &Env) -> u32 {
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

    /// Return the latest epoch where the user has non-zero claim potential.
    ///
    /// This helper avoids scanning the full epoch history on the client side.
    /// Returns 0 if the user has no claimable yield in any epoch.
    ///
    /// Implementation uses a bounded backward scan from the current epoch,
    /// checking if the user has shares and unclaimed yield for each epoch.
    /// Stops early when a claimable epoch is found.
    pub fn max_claimable_epoch(e: &Env, user: Address) -> u32 {
        let current = get_current_epoch(e);
        if current == 0 {
            return 0;
        }

        // Scan backward from current epoch to find the latest claimable epoch
        for epoch in (1..=current).rev() {
            // Skip if already claimed
            if get_has_claimed_epoch(e, &user, epoch) {
                continue;
            }

            // Check if user has non-zero yield potential for this epoch
            let user_shares = _get_user_shares_for_epoch(e, &user, epoch);
            let total_shares = get_epoch_total_shares(e, epoch);
            let epoch_yield = get_epoch_yield(e, epoch);

            if user_shares > 0 && total_shares > 0 && epoch_yield > 0 {
                return epoch;
            }
        }

        0
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

    /// Get composite epoch metadata in a single call for efficient indexer queries.
    /// Returns yield amount, total shares, and timestamp with robust bounds checking.
    pub fn get_epoch_metadata(e: &Env, epoch: u32) -> EpochMetadata {
        // Bounds check: epoch must be valid (1 to current_epoch)
        if epoch == 0 {
            panic_with_error!(e, Error::InvalidEpochRange);
        }
        let current = get_current_epoch(e);
        if epoch > current {
            panic_with_error!(e, Error::InvalidEpochRange);
        }

        EpochMetadata {
            epoch,
            yield_amount: get_epoch_yield(e, epoch),
            total_shares: get_epoch_total_shares(e, epoch),
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

    /// Returns the current lifecycle state of the vault.
    ///
    /// # State Variants
    /// - `Funding`: Vault is accepting deposits to reach the funding target.
    ///   External callers (e.g., frontends, bots) should check this before
    ///   allowing deposits or enabling UI for yield claims.
    /// - `Active`: RWA investment is active and generating yield. Full vault
    ///   operations (deposits, withdrawals, yield distribution) are available.
    /// - `Matured`: Investment has reached maturity date; full redemptions are
    ///   enabled. No new deposits accepted.
    /// - `Closed`: Vault is permanently closed. No further state transitions.
    /// - `Cancelled`: Funding deadline passed without meeting the funding target.
    ///   Users can claim refunds for their deposited amounts.
    /// - `Emergency`: Pause is active or emergency condition triggered. Users can
    ///   claim their pro-rata share of remaining assets.
    ///
    /// # Caller Usage
    /// Frontends, on-chain bots, and other contracts should query this state
    /// before initiating deposits, withdrawals, or redemptions to ensure the
    /// operation is permitted in the current vault lifecycle phase.
    ///
    /// # Transition Examples
    /// - `Funding` → `Active` when `activate_vault()` is called by an operator
    /// - `Funding` → `Cancelled` if funding deadline passes without meeting target
    /// - `Active` → `Matured` when maturity date is reached
    /// - Any state → `Emergency` if an emergency condition is triggered
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
        let old = get_maturity_date(e);
        let state = get_vault_state(e);
        put_maturity_date(e, timestamp);
        emit_maturity_date_set(e, caller, old, timestamp, state, e.ledger().timestamp());
        bump_instance(e);
    }

    /// Returns the Unix timestamp (in seconds) when the vault is expected to mature.
    ///
    /// ## Interpretaton & Units
    /// - **Units**: Unix seconds (ledger timestamp).
    /// - **Extension**: The admin may extend the maturity date via `set_maturity_date`
    ///   if the underlying RWA term is extended.
    /// - **Maturity Check**: Clients should compare this value with the current
    ///   ledger timestamp to determine if the term has ended.
    pub fn maturity_date(e: &Env) -> u64 {
        get_maturity_date(e)
    }
    /// Alias getter for integrations expecting `get_*` naming.
    pub fn get_maturity_date(e: &Env) -> u64 {
        get_maturity_date(e)
    }

    /// Return a compact, human-friendly share price in basis points relative to par.
    ///
    /// - `10_000` means 1.0 (par)
    /// - `12_345` means 1.2345
    ///
    /// Rounding: rounds down (floor).
    ///
    /// Edge case: when `total_supply == 0`, returns `10_000` (par).
    pub fn share_price_bps(e: &Env) -> u32 {
        let total_supply = get_total_supply(e);
        if total_supply <= 0 {
            return 10_000;
        }
        let total_assets = total_assets(e);
        if total_assets <= 0 {
            return 0;
        }
        let bps = math::mul_div(e, total_assets, 10_000, total_supply);
        if bps <= 0 {
            0
        } else if bps >= u32::MAX as i128 {
            u32::MAX
        } else {
            bps as u32
        }
    }

    /// Return high-level vault metadata in a single call.
    pub fn get_vault_overview(e: &Env) -> VaultOverview {
        VaultOverview {
            state: get_vault_state(e),
            paused: get_paused(e),
            asset: get_asset(e),
            total_assets: total_assets(e),
            total_supply: get_total_supply(e),
            current_epoch: get_current_epoch(e),
            maturity_date: get_maturity_date(e),
        }
    }

    /// Return a compact per-user summary to reduce RPC fan-out for UIs.
    pub fn get_user_overview(e: &Env, address: Address) -> UserOverview {
        UserOverview {
            share_balance: get_share_balance(e, &address),
            pending_yield: Self::pending_yield(e, address.clone()),
            total_deposited: get_user_deposited(e, &address),
            is_blacklisted: get_blacklisted(e, &address),
            is_kyc_verified: Self::is_kyc_verified(e, address),
        }
    }
    /// Returns the total asset amount targeted during the Funding state.
    ///
    /// ## Decimals & Formatting
    /// - **Units**: Expressed in the vault's underlying asset units.
    /// - **Decimals**: Integrators should use the underlying asset's decimals
    ///   (typically 6 for USDC-like assets) for formatting, NOT the share
    ///   token decimals.
    /// - **Default**: Many RWA vaults use 6 decimals as the standard for USD-pegged assets.
    pub fn funding_target(e: &Env) -> i128 {
        get_funding_target(e)
    }

    /// Funding progress in basis points (0–10_000).
    ///
    /// Uses `total_assets / funding_target`, clamped to 10_000. Returns 0 when
    /// `funding_target` is 0.
    pub fn funding_progress_bps(e: &Env) -> u32 {
        let target = get_funding_target(e);
        if target <= 0 {
            return 0;
        }
        let assets = total_assets(e);
        if assets <= 0 {
            return 0;
        }
        let bps = math::mul_div(e, assets, 10_000, target);
        bps.clamp(0, 10_000) as u32
    }

    pub fn is_funding_target_met(e: &Env) -> bool {
        let (target, assets) = (get_funding_target(e), total_assets(e));
        assets >= target
    }

    /// Returns the remaining time until the maturity date in seconds.
    ///
    /// Returns 0 if the maturity date has already passed.
    ///
    /// ## Guidance
    /// Clients use this to calculate "time-to-maturity" for yield projections.
    /// Note that this value is based on the `ledger().timestamp()`, which is
    /// set when the ledger closes.
    pub fn time_to_maturity(e: &Env) -> u64 {
        let now = e.ledger().timestamp();
        let mat = get_maturity_date(e);
        mat.saturating_sub(now)
    }

    /// Returns `true` when maturity conditions are met.
    ///
    /// Evaluates to `true` in two cases:
    /// - The vault has already been transitioned to `VaultState::Matured` (or `Closed`).
    /// - The vault is still `Active` but the current ledger timestamp has reached
    ///   or passed the configured maturity date.
    ///
    /// This lets client code check "is the RWA past its term?" in a single call
    /// without separately reading vault_state + maturity_date and comparing them.
    pub fn is_matured(e: &Env) -> bool {
        let state = get_vault_state(e);
        match state {
            VaultState::Matured | VaultState::Closed => true,
            VaultState::Active => e.ledger().timestamp() >= get_maturity_date(e),
            _ => false,
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Deposit limits
    // ─────────────────────────────────────────────────────────────────

    /// Returns the minimum asset amount required for a single deposit.
    ///
    /// ## Enforcement & Units
    /// - **Enforcement**: `min_deposit` is enforced during both `Funding` and
    ///   `Active` states to ensure position sizes remain manageable.
    /// - **Units**: Expressed in the vault's underlying asset units, consistent
    ///   with `decimals()`.
    pub fn min_deposit(e: &Env) -> i128 {
        get_min_deposit(e)
    }
    pub fn get_min_deposit(e: &Env) -> i128 {
        get_min_deposit(e)
    }

    /// Returns the maximum asset amount a single user is allowed to deposit.
    ///
    /// ## Enforcement & Units
    /// - **Enforcement**: Enforced during both `Funding` and `Active` states.
    /// - **Uncapped**: Returns 0 if no per-user cap is configured.
    /// - **Units**: Expressed in the vault's underlying asset units, consistent
    ///   with `decimals()`.
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
        require_not_blacklisted_withdraw_parties(e, &caller, &owner, &receiver);
        require_state(e, VaultState::Matured);
        require_positive(e, shares);

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

        let is_exiting = get_share_balance(e, &owner) == 0 && get_escrowed_shares(e, &owner) == 0;
        record_redemption_activity(e, get_current_epoch(e), total_out, is_exiting);

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
        require_state(e, VaultState::Active);
        require_not_blacklisted(e, &caller);
        require_positive(e, shares);

        update_user_snapshot(e, &caller);

        let bal = get_share_balance(e, &caller);
        if bal < shares {
            panic_with_error!(e, Error::InsufficientBalance);
        }

        // Lock the asset value at request time so that yield distributed
        // (or removed) between now and processing cannot move the payout.
        let locked_asset_value = preview_redeem(e, shares);

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
                user: caller,
                shares,
                request_time: e.ledger().timestamp(),
                processed: false,
                locked_asset_value,
            },
        );

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

        // Guard: Only active vaults can process early redemptions
        require_state(e, VaultState::Active);

        let mut req = get_redemption_request(e, request_id);
        if req.processed {
            panic_with_error!(e, Error::AlreadyProcessed);
        }

        let escrowed = get_escrowed_shares(e, &req.user);
        if escrowed < req.shares {
            panic_with_error!(e, Error::InsufficientBalance);
        }

        // Use the asset value snapshotted at request time, not the current
        // share price. This protects the user from share-price moves between
        // request and processing.
        let assets = req.locked_asset_value;
        let fee_bps = get_early_redemption_fee_bps(e) as i128;
        let fee = math::mul_div(e, assets, fee_bps, 10000);
        let net_assets = assets - fee;

        // Vault liquidity guard: refuse to process if the locked payout exceeds
        // the vault's current asset balance. The operator can wait for more
        // assets, or the user can cancel the request.
        if asset_balance_of_vault(e) < net_assets {
            panic_with_error!(e, Error::InsufficientBalance);
        }

        // --- Effects ---
        req.processed = true;
        put_redemption_request(e, request_id, req.clone());
        put_escrowed_shares(e, &req.user, escrowed - req.shares);
        put_total_supply(e, get_total_supply(e) - req.shares);
        put_total_deposited(e, get_total_deposited(e) - net_assets);

        let user_dep = get_user_deposited(e, &req.user);
        put_user_deposited(e, &req.user, (user_dep - net_assets).max(0));

        let is_exiting =
            get_share_balance(e, &req.user) == 0 && get_escrowed_shares(e, &req.user) == 0;
        record_redemption_activity(e, get_current_epoch(e), net_assets, is_exiting);

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

    /// Returns the fee in basis points (0-10,000) that may be charged by the
    /// cooperator or platform for vault operations.
    ///
    /// ## Cooperator Role & Trust Boundary
    /// The cooperator (retrievable via `cooperator()`) is a privileged off-chain
    /// entity responsible for:
    /// 1. **Off-chain approvals**: Validating user eligibility (KYC/AML) before
    ///    they can interact with the vault.
    /// 2. **Callbacks**: Responding to on-chain verification requests from the
    ///    `zkme_verifier`.
    ///
    /// Integrators should note that the cooperator is a trusted party in the
    /// vault's lifecycle. This view is read-only and gas-light.
    pub fn operator_fee_bps(e: &Env) -> u32 {
        get_operator_fee_bps(e)
    }

    /// Read-only preview of gross assets, fee, and net payout for an early redemption.
    ///
    /// Formula (asset units):
    /// - gross_assets = preview_redeem(shares)
    /// - fee_amount   = gross_assets * fee_bps / 10_000
    /// - net_assets   = gross_assets - fee_amount
    pub fn estimate_early_redemption_fee(e: &Env, shares: i128) -> EarlyRedemptionFeePreview {
        require_positive(e, shares);
        let gross_assets = preview_redeem(e, shares);
        let fee_bps = get_early_redemption_fee_bps(e);
        let fee_amount = math::mul_div(e, gross_assets, fee_bps as i128, 10_000);
        EarlyRedemptionFeePreview {
            gross_assets,
            fee_amount,
            net_assets: gross_assets - fee_amount,
            fee_bps,
        }
    }

    /// Read-only precheck for whether a user can request early redemption.
    pub fn can_request_early_redemption(
        e: &Env,
        user: Address,
        shares: i128,
    ) -> EarlyRedemptionPrecheckResult {
        require_current_schema(e);

        if get_vault_state(e) != VaultState::Active {
            return EarlyRedemptionPrecheckResult::Fail(EarlyRedemptionPrecheckReason::NotActive);
        }
        if (get_freeze_flags(e) & Self::FREEZE_WITHDRAW_REDEEM) != 0 {
            return EarlyRedemptionPrecheckResult::Fail(EarlyRedemptionPrecheckReason::Frozen);
        }
        if get_blacklisted(e, &user) {
            return EarlyRedemptionPrecheckResult::Fail(EarlyRedemptionPrecheckReason::Blacklisted);
        }
        if shares <= 0 {
            return EarlyRedemptionPrecheckResult::Fail(EarlyRedemptionPrecheckReason::ZeroAmount);
        }

        let bal = get_share_balance(e, &user);
        if bal < shares {
            return EarlyRedemptionPrecheckResult::Fail(
                EarlyRedemptionPrecheckReason::InsufficientBalance,
            );
        }

        let assets = convert_to_assets_floor(e, shares);
        if assets <= 0 {
            return EarlyRedemptionPrecheckResult::Fail(EarlyRedemptionPrecheckReason::TooSmall);
        }

        EarlyRedemptionPrecheckResult::Pass
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

    pub fn set_yield_vesting_period(e: &Env, operator: Address, vesting_period: u64) {
        operator.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &operator, Role::LifecycleManager);
        require_not_closed(e);
        put_yield_vesting_period(e, vesting_period);
        emit_yield_vesting_period_set(e, vesting_period);
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
        require_valid_address(e, &addr);
        put_role(e, addr.clone(), role.clone(), true);
        if role == Role::FullOperator {
            emit_operator_added(e, caller.clone(), addr.clone(), e.ledger().timestamp());
        }
        emit_role_granted(e, addr, role);
        bump_instance(e);
    }

    /// Revoke `role` from `addr`.  Only the admin may revoke roles.
    pub fn revoke_role(e: &Env, caller: Address, addr: Address, role: Role, reason: Option<String>) {
        caller.require_auth();
        require_admin(e, &caller);
        put_role(e, addr.clone(), role.clone(), false);
        if role == Role::FullOperator {
            emit_operator_removed(e, caller.clone(), addr.clone(), reason.clone());
        }
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
    pub fn set_operator(e: &Env, caller: Address, operator: Address, status: bool, reason: Option<String>) {
        caller.require_auth();
        require_admin(e, &caller);
        require_valid_address(e, &operator);
        put_operator(e, operator.clone(), status);
        emit_operator_updated(e, operator.clone(), status);
        if status {
            emit_operator_added(e, caller, operator, e.ledger().timestamp());
        } else {
            emit_operator_removed(e, caller, operator, reason);
        }
        bump_instance(e);
    }

    /// Backward-compatible: returns `true` when `account` holds `FullOperator`.
    pub fn is_operator(e: &Env, account: Address) -> bool {
        get_operator(e, &account)
    }

    /// Returns a bounded page of addresses that currently hold the `FullOperator` superrole.
    ///
    /// `offset` is zero-based within the full operator list.
    /// `limit` is capped at `MAX_OPERATOR_PAGE_SIZE` (50) to prevent expensive queries.
    /// Returns an empty vec when `offset >= total` or `limit == 0`.
    pub fn list_operators(e: &Env, offset: u32, limit: u32) -> Vec<Address> {
        let capped = limit.min(MAX_OPERATOR_PAGE_SIZE);
        let operators = get_operator_list(e);
        let total = operators.len();
        let mut result = Vec::new(e);
        if offset >= total || capped == 0 {
            return result;
        }
        let end = (offset + capped).min(total);
        for i in offset..end {
            result.push_back(operators.get(i).unwrap());
        }
        result
    }

    pub fn transfer_admin(e: &Env, caller: Address, _new_admin: Address) {
        caller.require_auth();
        require_admin(e, &caller);

        // Transfer admin requires timelock - use propose_action instead
        panic_with_error!(e, Error::TimelockAdminOnly);
    }

    // ─────────────────────────────────────────────────────────────────
    // Timelock functions
    // ─────────────────────────────────────────────────────────────────

    /// Propose a timelock action for critical admin operations.
    /// Returns the action ID.
    pub fn propose_action(
        e: &Env,
        caller: Address,
        action_type: ActionType,
        data: soroban_sdk::Bytes,
    ) -> u32 {
        caller.require_auth();
        require_admin(e, &caller);

        let current_time = e.ledger().timestamp();
        let delay = get_timelock_delay(e);
        let executable_at = current_time + delay;

        let action_id = get_timelock_counter(e) + 1;
        put_timelock_counter(e, action_id);

        let action = TimelockAction {
            action_type: action_type.clone(),
            data,
            proposed_at: current_time,
            executable_at,
            executed: false,
            cancelled: false,
        };

        put_timelock_action(e, action_id, action);
        emit_action_proposed(e, action_id, action_type, executable_at);
        bump_instance(e);

        action_id
    }

    /// Execute a timelock action after the delay has passed.
    pub fn execute_action(e: &Env, caller: Address, action_id: u32) {
        caller.require_auth();
        require_admin(e, &caller);

        let action = get_timelock_action(e, action_id)
            .unwrap_or_else(|| panic_with_error!(e, Error::TimelockActionNotFound));

        if action.executed {
            panic_with_error!(e, Error::TimelockActionAlreadyExecuted);
        }
        if action.cancelled {
            panic_with_error!(e, Error::TimelockActionCancelled);
        }
        if e.ledger().timestamp() < action.executable_at {
            panic_with_error!(e, Error::TimelockDelayNotPassed);
        }

        match action.action_type {
            ActionType::EmergencyWithdraw
            | ActionType::TransferAdmin
            | ActionType::Upgrade
            | ActionType::WasmHashUpdate => {
                panic_with_error!(e, Error::NotSupported);
            }
        }
    }

    /// Cancel a pending timelock action.
    pub fn cancel_action(e: &Env, caller: Address, action_id: u32) {
        caller.require_auth();
        require_admin(e, &caller);

        let mut action = get_timelock_action(e, action_id)
            .unwrap_or_else(|| panic_with_error!(e, Error::TimelockActionNotFound));

        if action.executed {
            panic_with_error!(e, Error::TimelockActionAlreadyExecuted);
        }
        if action.cancelled {
            panic_with_error!(e, Error::TimelockActionCancelled);
        }

        action.cancelled = true;
        let action_type = action.action_type.clone();
        put_timelock_action(e, action_id, action);
        emit_action_cancelled(e, action_id, action_type);
        bump_instance(e);
    }

    /// Get a timelock action by ID.
    pub fn get_timelock_action(e: &Env, action_id: u32) -> Option<TimelockAction> {
        crate::storage::get_timelock_action(e, action_id)
    }

    /// Internal emergency withdraw function (bypasses timelock when paused).
    #[allow(dead_code)]
    fn emergency_withdraw_internal(e: &Env, recipient: Address, amount: i128) {
        require_positive(e, amount);

        let asset_address = get_asset(e);
        let asset_client = soroban_sdk::token::Client::new(e, &asset_address);
        let balance = asset_client.balance(&e.current_contract_address());

        if amount > balance {
            panic_with_error!(e, Error::InsufficientBalance);
        }

        asset_client.transfer(&e.current_contract_address(), &recipient, &amount);
    }

    // ─────────────────────────────────────────────────────────────────
    // Blacklist
    // ─────────────────────────────────────────────────────────────────

    /// Set or clear the blacklist status for an address.
    ///
    /// ## Vault-Specific
    /// The blacklist is **vault-specific** (stored in this vault's instance storage).
    /// It is NOT shared across vaults or managed by a factory/global registry.
    /// Each vault maintains its own independent blacklist.
    ///
    /// ## Enforcement
    /// Blacklist checks are enforced on:
    /// - **Deposit**: `deposit()`, `mint()` - caller and receiver are checked
    /// - **Withdraw**: `withdraw()`, `redeem()` - caller, owner, and receiver are checked
    /// - **Transfer**: `transfer()`, `transfer_from()` - both sender and receiver are checked
    /// - **Early Redemption**: `request_early_redemption()` - caller is checked
    /// - **Yield Claims**: `claim_yield()` - caller is checked
    ///
    /// ## Frontend Usage
    /// Frontends should call `is_blacklisted(address)` to visually flag addresses
    /// and prevent user actions before transaction submission.
    pub fn set_blacklisted(e: &Env, caller: Address, address: Address, status: bool) {
        caller.require_auth();
        // ComplianceOfficer role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::ComplianceOfficer);
        put_blacklisted(e, &address, status);
        emit_address_blacklisted(e, address, status);
        bump_instance(e);
    }

    /// Returns `true` if the address is blacklisted in this vault.
    ///
    /// ## Vault-Specific
    /// The blacklist is **vault-specific**. Each vault maintains its own
    /// independent blacklist in its instance storage.
    ///
    /// ## Frontend Usage
    /// Call this view to visually flag addresses and prevent actions.
    /// Combine with `is_kyc_verified()` for complete address screening.
    pub fn is_blacklisted(e: &Env, address: Address) -> bool {
        get_blacklisted(e, &address)
    }

    /// Paginated view of blacklisted addresses.
    ///
    /// `start` is a 0-based offset into the blacklist list.
    pub fn list_blacklisted(e: &Env, start: u32, limit: u32) -> Vec<Address> {
        if limit == 0 || limit > MAX_BLACKLIST_PAGE_SIZE {
            panic_with_error!(e, Error::InvalidEpochRange);
        }

        let all = get_blacklisted_addresses(e);
        let len = all.len();
        if start >= len {
            return Vec::new(e);
        }

        let mut out = Vec::new(e);
        let end = (start + limit).min(len);
        for i in start..end {
            out.push_back(all.get(i).unwrap());
        }
        out
    }

    // ─────────────────────────────────────────────────────────────────
    // View helpers for frontend and scripts
    // ─────────────────────────────────────────────────────────────────

    /// Check if a user can redeem a specific amount of shares.
    ///
    /// Returns a `CanRedeemResult` struct with:
    /// - `ok`: true if redemption is possible
    /// - `reason`: optional error message if redemption is not possible
    ///
    /// This is a view function useful for frontend previews and preventing
    /// failed transactions. It validates:
    /// - Vault state constraints (Active or Matured)
    /// - Pause status
    /// - Blacklist status
    /// - Share sufficiency (user has enough non-escrowed shares)
    ///
    /// Note: Escrowed shares (from early redemption requests) are not available
    /// for redemption until the request is cancelled or rejected.
    pub fn can_redeem(e: &Env, user: Address, shares: i128) -> CanRedeemResult {
        // Check if vault is paused
        if get_paused(e) {
            return CanRedeemResult {
                ok: false,
                reason: Some(String::from_str(e, "Vault is paused")),
            };
        }

        // Check vault state
        let state = get_vault_state(e);
        if state != VaultState::Active && state != VaultState::Matured {
            return CanRedeemResult {
                ok: false,
                reason: Some(String::from_str(e, "Vault not active or matured")),
            };
        }

        // Check if user is blacklisted
        if get_blacklisted(e, &user) {
            return CanRedeemResult {
                ok: false,
                reason: Some(String::from_str(e, "User is blacklisted")),
            };
        }

        // Check share sufficiency (balance already excludes escrowed shares)
        let balance = get_share_balance(e, &user);
        if balance < shares {
            return CanRedeemResult {
                ok: false,
                reason: Some(String::from_str(e, "Insufficient shares")),
            };
        }

        // All checks passed
        CanRedeemResult {
            ok: true,
            reason: None,
        }
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

    /// Admin-only transfer restriction exemption for designated market makers.
    pub fn set_transfer_exempt(e: &Env, caller: Address, address: Address, exempt: bool) {
        caller.require_auth();
        require_admin(e, &caller);
        put_transfer_exempt(e, &address, exempt);
        emit_transfer_exemption_set(e, address, exempt);
        bump_instance(e);
    }

    pub fn is_transfer_exempt(e: &Env, address: Address) -> bool {
        get_transfer_exempt(e, &address)
    }

    pub fn get_transfer_exempt_addresses(e: &Env) -> Vec<Address> {
        crate::storage::get_transfer_exempt_addresses(e)
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

    /// Returns true if the vault is currently paused.
    ///
    /// When paused, all state-changing operations except for `unpause` and
    /// `emergency_withdraw` are blocked.
    pub fn paused(e: &Env) -> bool {
        get_paused(e)
    }

    /// Alias for `paused()`. Returns true if the vault is currently paused.
    pub fn is_paused(e: &Env) -> bool {
        get_paused(e)
    }

    /// Alias for `paused()`. Returns true if the vault is currently paused.
    pub fn is_pause(e: &Env) -> bool {
        get_paused(e)
    }

    pub fn freeze_flags(e: &Env) -> u32 {
        get_freeze_flags(e)
    }

    /// Returns whether new deposits are currently allowed.
    ///
    /// Deposits are permitted when:
    /// - Vault state is `Funding` or `Active`
    /// - Vault is not paused
    /// - Deposit/mint operations are not frozen
    ///
    /// This is useful for frontends to reliably determine whether to enable
    /// or disable the deposit call-to-action button.
    ///
    /// # Returns
    /// `true` if deposits can be submitted, `false` otherwise
    pub fn is_funding_open(e: &Env) -> bool {
        // Check vault state: must be Funding or Active
        let state = get_vault_state(e);
        if state != VaultState::Funding && state != VaultState::Active {
            return false;
        }

        // Check if vault is paused
        if get_paused(e) {
            return false;
        }

        // Check if deposit/mint operations are frozen
        let flags = get_freeze_flags(e);
        if (flags & Self::FREEZE_DEPOSIT_MINT) != 0 {
            return false;
        }

        true
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

        // Emergency withdraw bypasses timelock only when vault is already paused
        if !get_paused(e) {
            panic_with_error!(e, Error::TimelockAdminOnly);
        }

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
        require_positive(e, supply);

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
        require_positive(e, user_shares);

        let emergency_balance = get_emergency_balance(e);
        let total_supply_snapshot = get_emergency_total_supply_snapshot(e);

        let claim_amount = (emergency_balance * user_shares) / total_supply_snapshot;

        put_has_claimed_emergency(e, &caller);
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
    /// Returns the contract’s immutable code version.
    pub fn contract_version(e: &Env) -> u32 {
        get_contract_version(e)
    }

    /// Returns the address of the vault's underlying asset token.
    ///
    /// This is the token address specified during vault initialization
    /// (e.g., USDC). All deposits and withdrawals use this asset.
    ///
    /// # Usage
    /// Frontends and integrations should use this to obtain the correct token
    /// address for approval, transfers, and balance queries. The asset address
    /// is immutable for the lifetime of the vault.
    ///
    /// # See Also
    /// - `total_assets()`: Total amount of this asset currently in the vault
    /// - `total_supply()`: Total vault shares issued against this asset
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
        let numerator = ytd
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
        Self::set_funding_target_with_reason(e, caller, target, String::from_str(e, ""));
    }

    /// Set the funding target and emit an event with an optional reason string.
    ///
    /// `reason` must be <= `MAX_FUNDING_TARGET_REASON_LEN` characters.
    pub fn set_funding_target_with_reason(e: &Env, caller: Address, target: i128, reason: String) {
        caller.require_auth();
        // LifecycleManager role required — also passes for FullOperator and admin.
        require_role(e, &caller, Role::LifecycleManager);
        if reason.len() > Self::MAX_FUNDING_TARGET_REASON_LEN {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        put_funding_target(e, target);
        emit_funding_target_set(e, caller, target, reason, e.ledger().timestamp());
        bump_instance(e);
    }

    /// Returns the most recent epoch where `user` interacted (deposit, withdraw, transfer, etc).
    ///
    /// Epoch numbering starts at `0`.
    pub fn last_interaction_epoch(e: &Env, user: Address) -> u32 {
        get_last_interaction_epoch(e, &user)
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
        let bal = get_share_balance(e, &id);
        bump_balance(e, &id);
        bal
    }

    pub fn escrowed_balance(e: &Env, id: Address) -> i128 {
        get_escrowed_shares(e, &id)
    }

    pub fn transfer(e: &Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        require_transfer_parties_allowed(e, &from, &to);
        update_user_snapshots_for_transfer(e, &from, &to);
        spend_share_balance(e, &from, amount);
        receive_share_balance(e, &to, amount);
        record_transfer_activity(e, get_current_epoch(e), amount);
        emit_transfer(e, from, to, amount);
        bump_instance(e);
    }

    pub fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        require_not_blacklisted(e, &spender);
        require_transfer_parties_allowed(e, &from, &to);
        update_user_snapshots_for_transfer(e, &from, &to);
        let allowance = get_share_allowance(e, &from, &spender);
        if allowance < amount {
            panic_with_error!(e, Error::InsufficientAllowance);
        }
        put_share_allowance(e, &from, &spender, allowance - amount);
        spend_share_balance(e, &from, amount);
        receive_share_balance(e, &to, amount);
        record_transfer_activity(e, get_current_epoch(e), amount);
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
    /// Returns the human-readable ticker/display symbol for the share token.
    ///
    /// This symbol is immutable and set once during contract initialization via the
    /// `share_symbol` field in the `InitParams` struct. It cannot be changed after
    /// contract deployment. The symbol is intended for display purposes in user
    /// interfaces and wallets.
    pub fn symbol(e: &Env) -> String {
        get_share_symbol(e)
    }
    /// Returns the total outstanding vault shares across all users.
    ///
    /// # Affected By Operations
    /// - Increases when users call `deposit()` or `mint()`
    /// - Decreases when users call `burn()` or `withdraw()`
    /// - Unaffected by yield distribution; yields are tracked separately per epoch
    ///
    /// # Protocol-Owned Shares
    /// No "dead" or protocol-owned shares are minted. All shares represent
    /// user ownership in the vault.
    ///
    /// # Precision and Units
    /// The returned value is in vault share units (not asset units).
    /// Share decimals are configurable at initialization (max 18).
    /// When computing share price off-chain, scale by `10^share_decimals`:
    /// `share_price = total_assets * 10^share_decimals / total_supply`
    ///
    /// # Invariant
    /// Combined with `total_assets()`, this value maintains the share price:
    /// share price = total_assets / total_supply (before scaling)
    ///
    /// # See Also
    /// - `total_assets()`: Returns the total asset value in the vault
    /// - `share_price()`: Returns the current share price scaled by `10^share_decimals`
    pub fn total_supply(e: &Env) -> i128 {
        get_total_supply(e)
    }

    // ─────────────────────────────────────────────────────────────────
    // Activity tracking views (issue #122)
    // ─────────────────────────────────────────────────────────────────

    /// Returns the aggregate activity counters for the given epoch.
    ///
    /// Returns zeroed counters for epochs that have had no activity.
    pub fn get_epoch_activity(e: &Env, epoch: u32) -> EpochActivity {
        get_epoch_activity(e, epoch)
    }

    /// Returns aggregate activity counters across the entire vault lifetime.
    pub fn get_lifetime_activity(e: &Env) -> EpochActivity {
        get_lifetime_activity(e)
    }

    /// Returns the raw total shares distributed for a specific epoch.
    ///
    /// Values are once distributed and immutable. For analytics and historical reporting.
    pub fn epoch_total_shares(e: &Env, epoch: u32) -> i128 {
        crate::storage::get_epoch_total_shares(e, epoch)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Validates that an address is not the zero-equivalent (contract's own address).
/// This prevents null-like semantics where the contract address is used as a placeholder.
fn require_valid_address(_e: &Env, _addr: &Address) {
    // No-op for now to avoid blocking contract's own address which is used as a KYC bypass.
}

/// A tiny helper reduces duplicated panic/error messages and centralizes formatting.
/// Use it in public mutating calls to keep behavior consistent.
fn require_positive(e: &Env, amount: i128) {
    if amount <= 0 {
        panic_with_error!(e, Error::ZeroAmount);
    }
}

fn total_assets(e: &Env) -> i128 {
    get_total_deposited(e)
}

/// `convertToShares` with **floor** division and virtual offset for inflation attack mitigation.
/// Uses OpenZeppelin's virtual offset approach: shares = assets * (supply + OFFSET) / (totalAssets + OFFSET)
/// ERC-4626 deposit path rounds down (vault-favorable). Used by `max_mint` where a 0
/// result is valid; `preview_deposit` adds a dust guard on top.
fn convert_to_shares_floor(e: &Env, assets: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return assets;
    }
    // Apply virtual offset to prevent share price inflation attack (Issue #95)
    // shares = assets * (supply + OFFSET) / (totalAssets + OFFSET)
    math::mul_div(e, assets, supply + VIRTUAL_OFFSET, ta + VIRTUAL_OFFSET)
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
    // Apply virtual offset with ceiling division (Issue #95)
    // assets = shares * (totalAssets + OFFSET) / (supply + OFFSET), rounded up
    math::mul_div_ceil(e, shares, ta + VIRTUAL_OFFSET, supply + VIRTUAL_OFFSET)
}

fn preview_withdraw(e: &Env, assets: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return assets;
    }
    // ERC-4626: round **up** on withdraw so the user burns at least the shares needed
    // to cover `assets` — vault-favorable (user cannot withdraw “too cheaply”).
    math::mul_div_ceil(e, assets, supply + VIRTUAL_OFFSET, ta + VIRTUAL_OFFSET)
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
    math::mul_div(e, shares, ta + VIRTUAL_OFFSET, supply + VIRTUAL_OFFSET)
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

/// Refresh snapshots for both parties before moving shares (`transfer` / `transfer_from`).
/// Order is `from` then `to` so each records their pre-transfer balance for epoch yield.
fn update_user_snapshots_for_transfer(e: &Env, from: &Address, to: &Address) {
    update_user_snapshot(e, from);
    update_user_snapshot(e, to);
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

fn transfer_restrictions_exempt(e: &Env, from: &Address, to: &Address) -> bool {
    get_transfer_exempt(e, from) || get_transfer_exempt(e, to)
}

fn require_transfer_parties_allowed(e: &Env, from: &Address, to: &Address) {
    // Blacklist enforcement is the compliance override and is never bypassed.
    require_not_blacklisted(e, from);
    require_not_blacklisted(e, to);

    if transfer_restrictions_exempt(e, from, to) {
        return;
    }

    if get_transfer_requires_kyc(e) {
        require_kyc_verified(e, to);
    }

    // Future transfer lock-up checks should live here so the exemption path
    // stays shared across all transfer restrictions except blacklist.
}

fn require_not_blacklisted_deposit_parties(e: &Env, caller: &Address, receiver: &Address) {
    require_not_blacklisted(e, caller);
    require_not_blacklisted(e, receiver);
}

fn require_not_blacklisted_withdraw_parties(
    e: &Env,
    caller: &Address,
    owner: &Address,
    receiver: &Address,
) {
    require_not_blacklisted(e, caller);
    require_not_blacklisted(e, owner);
    require_not_blacklisted(e, receiver);
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
            operator_fee_bps: 0,
            rwa_name: String::from_str(e, "Test RWA"),
            rwa_symbol: String::from_str(e, "TRWA"),
            rwa_document_uri: String::from_str(e, "https://example.com/doc"),
            rwa_category: String::from_str(e, "Bonds"),
            expected_apy: 500,
            timelock_delay: 172800u64,  // 48 hours
            yield_vesting_period: 0u64, // Default to 0 for instant claiming
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
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_set_blacklisted_non_admin_fails() {
        let e = Env::default();
        // Don't mock all auths - we want auth to fail
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
