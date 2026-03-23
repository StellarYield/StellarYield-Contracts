#![no_std]

mod storage;
mod types;
mod token_interface;
mod events;
mod errors;

pub use crate::types::*;

use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, Address, Env, String,
};

use crate::storage::*;
use crate::errors::Error;
use crate::events::*;
use crate::token_interface::*;

// ─────────────────────────────────────────────────────────────────────────────
// Contract struct
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct SingleRWAVault;

#[contractimpl]
impl SingleRWAVault {
    // ─────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────

    /// Initialise a new Single-RWA Vault.
    ///
    /// Parameters are grouped into an `InitParams` struct because Soroban
    /// enforces a maximum of 10 arguments per contract function.
    pub fn __constructor(e: &Env, params: InitParams) {
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
        put_min_deposit(e, params.min_deposit);
        put_max_deposit_per_user(e, params.max_deposit_per_user);
        put_early_redemption_fee_bps(e, params.early_redemption_fee_bps);

        // Initial state
        put_vault_state(e, VaultState::Funding);
        put_paused(e, false);
        put_current_epoch(e, 0u32);
        put_total_yield_distributed(e, 0i128);
        put_redemption_counter(e, 0u32);
        put_total_supply(e, 0i128);

        e.storage().instance().extend_ttl(
            INSTANCE_LIFETIME_THRESHOLD,
            INSTANCE_BUMP_AMOUNT,
        );
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

    pub fn rwa_name(e: &Env) -> String { get_rwa_name(e) }
    pub fn rwa_symbol(e: &Env) -> String { get_rwa_symbol(e) }
    pub fn rwa_document_uri(e: &Env) -> String { get_rwa_document_uri(e) }
    pub fn rwa_category(e: &Env) -> String { get_rwa_category(e) }

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

    pub fn zkme_verifier(e: &Env) -> Address { get_zkme_verifier(e) }
    pub fn cooperator(e: &Env) -> Address { get_cooperator(e) }

    pub fn set_zkme_verifier(e: &Env, caller: Address, verifier: Address) {
        caller.require_auth();
        require_admin(e, &caller);
        let old = get_zkme_verifier(e);
        put_zkme_verifier(e, verifier.clone());
        emit_zkme_verifier_updated(e, old, verifier);
        bump_instance(e);
    }

    pub fn set_cooperator(e: &Env, caller: Address, new_cooperator: Address) {
        caller.require_auth();
        require_admin(e, &caller);
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
    pub fn deposit(e: &Env, caller: Address, assets: i128, receiver: Address) -> i128 {
        caller.require_auth();
        require_not_paused(e);
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

        update_user_snapshot(e, &receiver);
        put_user_deposited(e, &receiver, get_user_deposited(e, &receiver) + assets);

        let shares = preview_deposit(e, assets);
        transfer_asset_to_vault(e, &caller, assets);
        _mint(e, &receiver, shares);

        bump_instance(e);
        shares
    }

    /// Mint exactly `shares`; caller pays the corresponding assets.
    pub fn mint(e: &Env, caller: Address, shares: i128, receiver: Address) -> i128 {
        caller.require_auth();
        require_not_paused(e);
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

        update_user_snapshot(e, &receiver);
        put_user_deposited(e, &receiver, get_user_deposited(e, &receiver) + assets);

        transfer_asset_to_vault(e, &caller, assets);
        _mint(e, &receiver, shares);

        bump_instance(e);
        assets
    }

    /// Withdraw exactly `assets` worth of underlying; burns the corresponding shares.
    pub fn withdraw(e: &Env, caller: Address, assets: i128, receiver: Address, owner: Address) -> i128 {
        caller.require_auth();
        require_not_paused(e);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &owner);
        require_not_blacklisted(e, &receiver);

        if caller != owner {
            let allowance = get_share_allowance(e, &owner, &caller);
            let shares_needed = preview_withdraw(e, assets);
            if allowance < shares_needed {
                panic!("insufficient allowance");
            }
            put_share_allowance(e, &owner, &caller, allowance - shares_needed);
        }

        update_user_snapshot(e, &owner);
        let shares = preview_withdraw(e, assets);
        _burn(e, &owner, shares);
        transfer_asset_from_vault(e, &receiver, assets);

        bump_instance(e);
        shares
    }

    /// Redeem `shares`; receive the corresponding underlying assets.
    pub fn redeem(e: &Env, caller: Address, shares: i128, receiver: Address, owner: Address) -> i128 {
        caller.require_auth();
        require_not_paused(e);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &owner);
        require_not_blacklisted(e, &receiver);

        if caller != owner {
            let allowance = get_share_allowance(e, &owner, &caller);
            if allowance < shares {
                panic!("insufficient allowance");
            }
            put_share_allowance(e, &owner, &caller, allowance - shares);
        }

        update_user_snapshot(e, &owner);
        let assets = preview_redeem(e, shares);
        _burn(e, &owner, shares);
        transfer_asset_from_vault(e, &receiver, assets);

        bump_instance(e);
        assets
    }

    // ─────────────────────────────────────────────────────────────────
    // ERC-4626 preview helpers
    // ─────────────────────────────────────────────────────────────────

    pub fn preview_deposit(e: &Env, assets: i128) -> i128 { preview_deposit(e, assets) }
    pub fn preview_mint(e: &Env, shares: i128) -> i128    { preview_mint(e, shares) }
    pub fn preview_withdraw(e: &Env, assets: i128) -> i128 { preview_withdraw(e, assets) }
    pub fn preview_redeem(e: &Env, shares: i128) -> i128  { preview_redeem(e, shares) }

    pub fn total_assets(e: &Env) -> i128 { total_assets(e) }

    // ─────────────────────────────────────────────────────────────────
    // Yield distribution
    // ─────────────────────────────────────────────────────────────────

    /// Operator transfers `amount` of asset into the vault and records a new epoch.
    pub fn distribute_yield(e: &Env, caller: Address, amount: i128) -> u32 {
        caller.require_auth();
        require_not_paused(e);
        require_operator(e, &caller);
        require_state(e, VaultState::Active);

        if amount <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }

        // Pull yield tokens into vault
        transfer_asset_to_vault(e, &caller, amount);

        let epoch = get_current_epoch(e) + 1;
        put_current_epoch(e, epoch);
        put_epoch_yield(e, epoch, amount);
        put_epoch_total_shares(e, epoch, get_total_supply(e));
        put_total_yield_distributed(
            e,
            get_total_yield_distributed(e) + amount,
        );

        emit_yield_distributed(e, epoch, amount, e.ledger().timestamp());
        bump_instance(e);
        epoch
    }

    /// Claim all pending yield for the caller.
    pub fn claim_yield(e: &Env, caller: Address) -> i128 {
        caller.require_auth();
        require_not_paused(e);
        require_not_blacklisted(e, &caller);

        let amount = Self::pending_yield(e, caller.clone());
        if amount <= 0 {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        let epoch = get_current_epoch(e);
        for i in 1..=epoch {
            if !get_has_claimed_epoch(e, &caller, i) {
                if _get_user_shares_for_epoch(e, &caller, i) > 0 {
                    put_has_claimed_epoch(e, &caller, i, true);
                }
            }
        }

        put_total_yield_claimed(
            e,
            &caller,
            get_total_yield_claimed(e, &caller) + amount,
        );
        transfer_asset_from_vault(e, &caller, amount);

        emit_yield_claimed(e, caller, amount, epoch);
        bump_instance(e);
        amount
    }

    /// Claim yield for a specific epoch only.
    pub fn claim_yield_for_epoch(e: &Env, caller: Address, epoch: u32) -> i128 {
        caller.require_auth();
        require_not_paused(e);
        require_not_blacklisted(e, &caller);

        if get_has_claimed_epoch(e, &caller, epoch) {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        let amount = Self::pending_yield_for_epoch(e, caller.clone(), epoch);
        if amount <= 0 {
            panic_with_error!(e, Error::NoYieldToClaim);
        }

        put_has_claimed_epoch(e, &caller, epoch, true);
        put_total_yield_claimed(
            e,
            &caller,
            get_total_yield_claimed(e, &caller) + amount,
        );
        transfer_asset_from_vault(e, &caller, amount);

        emit_yield_claimed(e, caller, amount, epoch);
        bump_instance(e);
        amount
    }

    pub fn pending_yield(e: &Env, user: Address) -> i128 {
        let epoch = get_current_epoch(e);
        let mut total = 0i128;
        for i in 1..=epoch {
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
        (get_epoch_yield(e, epoch) * user_shares) / total_shares
    }

    pub fn current_epoch(e: &Env) -> u32 { get_current_epoch(e) }
    pub fn epoch_yield(e: &Env, epoch: u32) -> i128 { get_epoch_yield(e, epoch) }
    pub fn total_yield_distributed(e: &Env) -> i128 { get_total_yield_distributed(e) }
    pub fn total_yield_claimed(e: &Env, user: Address) -> i128 { get_total_yield_claimed(e, &user) }

    // ─────────────────────────────────────────────────────────────────
    // Vault lifecycle
    // ─────────────────────────────────────────────────────────────────

    pub fn vault_state(e: &Env) -> VaultState { get_vault_state(e) }

    /// Transition Funding → Active.  Requires funding target to be met.
    pub fn activate_vault(e: &Env, caller: Address) {
        caller.require_auth();
        require_operator(e, &caller);
        require_state(e, VaultState::Funding);
        if !Self::is_funding_target_met(e) {
            panic_with_error!(e, Error::FundingTargetNotMet);
        }
        put_vault_state(e, VaultState::Active);
        emit_vault_state_changed(e, VaultState::Funding, VaultState::Active);
        bump_instance(e);
    }

    /// Transition Active → Matured.  Requires block timestamp ≥ maturityDate.
    pub fn mature_vault(e: &Env, caller: Address) {
        caller.require_auth();
        require_operator(e, &caller);
        require_state(e, VaultState::Active);
        let now = e.ledger().timestamp();
        if now < get_maturity_date(e) {
            panic_with_error!(e, Error::NotMatured);
        }
        put_vault_state(e, VaultState::Matured);
        emit_vault_state_changed(e, VaultState::Active, VaultState::Matured);
        bump_instance(e);
    }

    pub fn set_maturity_date(e: &Env, caller: Address, timestamp: u64) {
        caller.require_auth();
        require_operator(e, &caller);
        put_maturity_date(e, timestamp);
        emit_maturity_date_set(e, timestamp);
        bump_instance(e);
    }

    pub fn maturity_date(e: &Env) -> u64 { get_maturity_date(e) }
    pub fn funding_target(e: &Env) -> i128 { get_funding_target(e) }

    pub fn is_funding_target_met(e: &Env) -> bool {
        total_assets(e) >= get_funding_target(e)
    }

    pub fn time_to_maturity(e: &Env) -> u64 {
        let now = e.ledger().timestamp();
        let mat = get_maturity_date(e);
        if now >= mat { 0 } else { mat - now }
    }

    // ─────────────────────────────────────────────────────────────────
    // Deposit limits
    // ─────────────────────────────────────────────────────────────────

    pub fn min_deposit(e: &Env) -> i128 { get_min_deposit(e) }
    pub fn max_deposit_per_user(e: &Env) -> i128 { get_max_deposit_per_user(e) }
    pub fn user_deposited(e: &Env, user: Address) -> i128 { get_user_deposited(e, &user) }

    pub fn set_deposit_limits(e: &Env, caller: Address, min_amount: i128, max_amount: i128) {
        caller.require_auth();
        require_operator(e, &caller);
        put_min_deposit(e, min_amount);
        put_max_deposit_per_user(e, max_amount);
        emit_deposit_limits_updated(e, min_amount, max_amount);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Redemption
    // ─────────────────────────────────────────────────────────────────

    /// Full redemption at maturity.  Automatically claims pending yield.
    pub fn redeem_at_maturity(
        e: &Env,
        caller: Address,
        shares: i128,
        receiver: Address,
        owner: Address,
    ) -> i128 {
        caller.require_auth();
        require_not_paused(e);
        require_not_blacklisted(e, &caller);
        require_not_blacklisted(e, &owner);
        require_not_blacklisted(e, &receiver);
        require_state(e, VaultState::Matured);

        if caller != owner {
            let allowance = get_share_allowance(e, &owner, &caller);
            if allowance < shares {
                panic!("insufficient allowance");
            }
            put_share_allowance(e, &owner, &caller, allowance - shares);
        }

        // Auto-claim pending yield
        let pending = Self::pending_yield(e, owner.clone());
        let epoch = get_current_epoch(e);
        if pending > 0 {
            for i in 1..=epoch {
                put_has_claimed_epoch(e, &owner, i, true);
            }
            put_total_yield_claimed(
                e,
                &owner,
                get_total_yield_claimed(e, &owner) + pending,
            );
        }

        update_user_snapshot(e, &owner);
        let assets = preview_redeem(e, shares);
        _burn(e, &owner, shares);

        let mut total_out = assets;
        if pending > 0 {
            total_out += pending;
        }
        transfer_asset_from_vault(e, &receiver, total_out);

        bump_instance(e);
        total_out
    }

    /// Request early redemption (pending operator approval).
    pub fn request_early_redemption(e: &Env, caller: Address, shares: i128) -> u32 {
        caller.require_auth();
        require_not_paused(e);
        require_not_blacklisted(e, &caller);

        if shares <= 0 {
            panic_with_error!(e, Error::ZeroAmount);
        }
        if get_share_balance(e, &caller) < shares {
            panic!("insufficient shares");
        }

        let id = get_redemption_counter(e) + 1;
        put_redemption_counter(e, id);
        put_redemption_request(e, id, RedemptionRequest {
            user: caller,
            shares,
            request_time: e.ledger().timestamp(),
            processed: false,
        });

        bump_instance(e);
        id
    }

    /// Operator processes an early redemption request.
    pub fn process_early_redemption(e: &Env, caller: Address, request_id: u32) {
        caller.require_auth();
        require_operator(e, &caller);

        let mut req = get_redemption_request(e, request_id);
        if req.processed {
            panic!("already processed");
        }

        req.processed = true;
        put_redemption_request(e, request_id, req.clone());

        let assets = preview_redeem(e, req.shares);
        let fee_bps = get_early_redemption_fee_bps(e) as i128;
        let fee = (assets * fee_bps) / 10000;
        let net_assets = assets - fee;

        update_user_snapshot(e, &req.user);
        _burn(e, &req.user, req.shares);
        transfer_asset_from_vault(e, &req.user, net_assets);
        // Fee stays in vault for other depositors

        bump_instance(e);
    }

    pub fn early_redemption_fee_bps(e: &Env) -> u32 { get_early_redemption_fee_bps(e) }
    pub fn set_early_redemption_fee(e: &Env, caller: Address, fee_bps: u32) {
        caller.require_auth();
        require_operator(e, &caller);
        if fee_bps > 1000 {
            panic!("fee too high");
        }
        put_early_redemption_fee_bps(e, fee_bps);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Access control
    // ─────────────────────────────────────────────────────────────────

    pub fn admin(e: &Env) -> Address { get_admin(e) }

    pub fn is_operator(e: &Env, account: Address) -> bool {
        get_operator(e, &account)
    }

    pub fn set_operator(e: &Env, caller: Address, operator: Address, status: bool) {
        caller.require_auth();
        require_admin(e, &caller);
        put_operator(e, operator.clone(), status);
        emit_operator_updated(e, operator, status);
        bump_instance(e);
    }

    pub fn transfer_admin(e: &Env, caller: Address, new_admin: Address) {
        caller.require_auth();
        require_admin(e, &caller);
        put_admin(e, new_admin);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Blacklist
    // ─────────────────────────────────────────────────────────────────

    pub fn set_blacklisted(e: &Env, caller: Address, address: Address, status: bool) {
        caller.require_auth();
        require_admin(e, &caller);
        put_blacklisted(e, &address, status);
        emit_address_blacklisted(e, address, status);
        bump_instance(e);
    }

    pub fn is_blacklisted(e: &Env, address: Address) -> bool {
        get_blacklisted(e, &address)
    }

    // ─────────────────────────────────────────────────────────────────
    // Emergency
    // ─────────────────────────────────────────────────────────────────

    pub fn pause(e: &Env, caller: Address, reason: String) {
        caller.require_auth();
        require_operator(e, &caller);
        put_paused(e, true);
        emit_emergency_action(e, true, reason);
        bump_instance(e);
    }

    pub fn unpause(e: &Env, caller: Address) {
        caller.require_auth();
        require_operator(e, &caller);
        put_paused(e, false);
        emit_emergency_action(e, false, String::from_str(e, ""));
        bump_instance(e);
    }

    pub fn paused(e: &Env) -> bool { get_paused(e) }

    pub fn emergency_withdraw(e: &Env, caller: Address, recipient: Address) {
        caller.require_auth();
        require_admin(e, &caller);
        let balance = asset_balance_of_vault(e);
        if balance > 0 {
            transfer_asset_from_vault(e, &recipient, balance);
        }
        put_paused(e, true);
        emit_emergency_action(e, true, String::from_str(e, "Emergency withdrawal executed"));
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────

    pub fn asset(e: &Env) -> Address { get_asset(e) }

    pub fn current_apy(e: &Env) -> u32 {
        let epoch = get_current_epoch(e);
        let ta = total_assets(e);
        if epoch == 0 || ta == 0 {
            return get_expected_apy(e);
        }
        let ytd = get_total_yield_distributed(e);
        ((ytd * 10000) / ta) as u32
    }

    pub fn expected_apy(e: &Env) -> u32 { get_expected_apy(e) }
    pub fn set_funding_target(e: &Env, caller: Address, target: i128) {
        caller.require_auth();
        require_operator(e, &caller);
        put_funding_target(e, target);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // SEP-41 Token Interface (vault shares)
    // ─────────────────────────────────────────────────────────────────

    pub fn allowance(e: &Env, from: Address, spender: Address) -> i128 {
        get_share_allowance(e, &from, &spender)
    }

    pub fn approve(
        e: &Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        put_share_allowance_with_expiry(e, &from, &spender, amount, expiration_ledger);
        emit_approval(e, from, spender, amount, expiration_ledger);
        bump_instance(e);
    }

    pub fn balance(e: &Env, id: Address) -> i128 {
        get_share_balance(e, &id)
    }

    pub fn transfer(e: &Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        require_not_blacklisted(e, &from);
        require_not_blacklisted(e, &to);
        update_user_snapshot(e, &from);
        update_user_snapshot(e, &to);
        spend_share_balance(e, &from, amount);
        receive_share_balance(e, &to, amount);
        emit_transfer(e, from, to, amount);
        bump_instance(e);
    }

    pub fn transfer_from(
        e: &Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) {
        spender.require_auth();
        require_not_blacklisted(e, &spender);
        require_not_blacklisted(e, &from);
        require_not_blacklisted(e, &to);
        update_user_snapshot(e, &from);
        update_user_snapshot(e, &to);
        let allowance = get_share_allowance(e, &from, &spender);
        if allowance < amount {
            panic!("insufficient allowance");
        }
        put_share_allowance(e, &from, &spender, allowance - amount);
        spend_share_balance(e, &from, amount);
        receive_share_balance(e, &to, amount);
        emit_transfer(e, from, to, amount);
        bump_instance(e);
    }

    pub fn burn(e: &Env, from: Address, amount: i128) {
        from.require_auth();
        _burn(e, &from, amount);
        emit_burn(e, from, amount);
        bump_instance(e);
    }

    pub fn burn_from(e: &Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        let allowance = get_share_allowance(e, &from, &spender);
        if allowance < amount {
            panic!("insufficient allowance");
        }
        put_share_allowance(e, &from, &spender, allowance - amount);
        _burn(e, &from, amount);
        emit_burn(e, from, amount);
        bump_instance(e);
    }

    pub fn decimals(e: &Env) -> u32 { get_share_decimals(e) }
    pub fn name(e: &Env) -> String  { get_share_name(e) }
    pub fn symbol(e: &Env) -> String { get_share_symbol(e) }
    pub fn total_supply(e: &Env) -> i128 { get_total_supply(e) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn total_assets(e: &Env) -> i128 {
    asset_balance_of_vault(e)
}

fn preview_deposit(e: &Env, assets: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return assets;
    }
    // shares = assets * totalSupply / totalAssets
    assets * supply / ta
}

fn preview_mint(e: &Env, shares: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return shares;
    }
    // assets = shares * totalAssets / totalSupply  (ceil)
    (shares * ta + supply - 1) / supply
}

fn preview_withdraw(e: &Env, assets: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 || ta == 0 {
        return assets;
    }
    // shares = assets * totalSupply / totalAssets  (ceil)
    (assets * supply + ta - 1) / ta
}

fn preview_redeem(e: &Env, shares: i128) -> i128 {
    let supply = get_total_supply(e);
    let ta = total_assets(e);
    if supply == 0 {
        return shares;
    }
    // assets = shares * totalAssets / totalSupply
    shares * ta / supply
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
    let bal = get_share_balance(e, from);
    if bal < amount {
        panic!("insufficient balance");
    }
    put_share_balance(e, from, bal - amount);
    put_total_supply(e, get_total_supply(e) - amount);
    bump_balance(e, from);
}

fn spend_share_balance(e: &Env, from: &Address, amount: i128) {
    let bal = get_share_balance(e, from);
    if bal < amount {
        panic!("insufficient balance");
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

fn require_admin(e: &Env, caller: &Address) {
    if *caller != get_admin(e) {
        panic_with_error!(e, Error::NotAdmin);
    }
}

fn require_operator(e: &Env, caller: &Address) {
    if !get_operator(e, caller) && *caller != get_admin(e) {
        panic_with_error!(e, Error::NotOperator);
    }
}

fn require_not_paused(e: &Env) {
    if get_paused(e) {
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

fn require_active_or_funding(e: &Env) {
    let state = get_vault_state(e);
    if state != VaultState::Funding && state != VaultState::Active {
        panic_with_error!(e, Error::InvalidVaultState);
    }
}

fn require_not_blacklisted(e: &Env, addr: &Address) {
    if get_blacklisted(e, addr) {
        panic_with_error!(e, Error::AddressBlacklisted);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn create_test_token(e: &Env) -> Address {
        e.register_stellar_asset_contract_v2(Address::generate(e)).address()
    }

    fn create_vault(e: &Env) -> (Address, Address, Address) {
        let admin = Address::generate(e);
        let asset = create_test_token(e);

        let params = InitParams {
            asset: asset.clone(),
            share_name: String::from_str(e, "Vault Share"),
            share_symbol: String::from_str(e, "vSHARE"),
            share_decimals: 7,
            admin: admin.clone(),
            zkme_verifier: e.current_contract_address(),
            cooperator: admin.clone(),
            funding_target: 1000_0000000,
            maturity_date: 0,
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

        assert_eq!(client.is_blacklisted(&user), false);

        client.set_blacklisted(&admin, &user, &true);
        assert_eq!(client.is_blacklisted(&user), true);

        client.set_blacklisted(&admin, &user, &false);
        assert_eq!(client.is_blacklisted(&user), false);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_set_blacklisted_non_admin_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let (vault_addr, _admin, _asset) = create_vault(&e);
        let client = SingleRWAVaultClient::new(&e, &vault_addr);

        let non_admin = Address::generate(&e);
        let user = Address::generate(&e);

        client.set_blacklisted(&non_admin, &user, &true);
    }
}
