//! Regression tests for version getters, allowance errors, zero-address
//! validation, and `max_claimable_epoch` bounds.
//!
//! Covers GitHub issues #1352, #1354, #1355, #1356.

extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::Address;

use crate::migrations::CURRENT_SCHEMA_VERSION;
use crate::test_helpers::{mint_usdc, setup, setup_with_kyc_bypass, TestContext};
use crate::{Role, SingleRWAVault};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// The Stellar null address (all-zero ed25519 account key).
fn zero_address(env: &soroban_sdk::Env) -> Address {
    Address::from_str(
        env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    )
}

/// Extract the panic message from a caught contract panic.
fn panic_message(err: std::boxed::Box<dyn std::any::Any + Send>) -> std::string::String {
    match err.downcast::<std::string::String>() {
        Ok(s) => *s,
        Err(err) => match err.downcast::<&'static str>() {
            Ok(s) => std::string::String::from(*s),
            Err(err) => std::format!("{err:?}"),
        },
    }
}

/// Assert that `f` panics with `Error(Contract, #code)`.
fn assert_panics_with<F, R>(f: F, code: u32)
where
    F: FnOnce() -> R + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(f) {
        Ok(_) => panic!("expected contract call to panic with Error(Contract, #{code})"),
        Err(e) => {
            let msg = panic_message(e);
            let needle = std::format!("Error(Contract, #{code})");
            assert!(
                msg.contains(needle.as_str()),
                "expected {needle}, got: {msg}"
            );
        }
    }
}

/// KYC-approved user holding no shares.
fn kyc_user(ctx: &TestContext) -> Address {
    let user = Address::generate(&ctx.env);
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&user);
    user
}

/// KYC-approved user with `amount` USDC deposited as vault shares.
fn user_with_shares(ctx: &TestContext, amount: i128) -> Address {
    let user = kyc_user(ctx);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, amount);
    ctx.vault().deposit(&user, &amount, &user);
    user
}

// ─────────────────────────────────────────────────────────────────────────────
// #1352 — contract_version / storage_schema_version
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_versions_match_constants_on_fresh_vault() {
    let ctx = setup();

    assert_eq!(ctx.vault().contract_version(), 1);
    assert_eq!(ctx.vault().version(), 1);
    assert_eq!(ctx.vault().storage_schema_version(), CURRENT_SCHEMA_VERSION);
}

#[test]
fn test_versions_unchanged_by_deposit() {
    let ctx = setup();
    let user = user_with_shares(&ctx, 1_000_000);

    assert!(ctx.vault().balance(&user) > 0);
    assert_eq!(ctx.vault().contract_version(), 1);
    assert_eq!(ctx.vault().version(), 1);
    assert_eq!(ctx.vault().storage_schema_version(), CURRENT_SCHEMA_VERSION);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1355 — ZeroAddress rejection
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_constructor_rejects_zero_admin() {
    let ctx = setup();
    let mut params = ctx.params.clone();
    params.admin = zero_address(&ctx.env);
    ctx.env.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_constructor_rejects_zero_cooperator() {
    let ctx = setup();
    let mut params = ctx.params.clone();
    params.cooperator = zero_address(&ctx.env);
    ctx.env.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_set_zkme_verifier_rejects_zero_address() {
    let ctx = setup();
    ctx.vault()
        .set_zkme_verifier(&ctx.admin, &zero_address(&ctx.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_set_cooperator_rejects_zero_address() {
    let ctx = setup();
    ctx.vault()
        .set_cooperator(&ctx.admin, &zero_address(&ctx.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_set_operator_rejects_zero_address() {
    let ctx = setup();
    ctx.vault()
        .set_operator(&ctx.admin, &zero_address(&ctx.env), &true, &None);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_grant_role_rejects_zero_address() {
    let ctx = setup();
    ctx.vault()
        .grant_role(&ctx.admin, &zero_address(&ctx.env), &Role::FullOperator);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_revoke_role_rejects_zero_address() {
    let ctx = setup();
    ctx.vault().revoke_role(
        &ctx.admin,
        &zero_address(&ctx.env),
        &Role::FullOperator,
        &None,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_set_blacklisted_rejects_zero_address() {
    let ctx = setup();
    ctx.vault()
        .set_blacklisted(&ctx.admin, &zero_address(&ctx.env), &true);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_set_transfer_exempt_rejects_zero_address() {
    let ctx = setup();
    ctx.vault()
        .set_transfer_exempt(&ctx.admin, &zero_address(&ctx.env), &true);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1356 — InsufficientAllowance on allowance-spending paths
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_transfer_from_rejects_amount_above_allowance() {
    let ctx = setup();
    let owner = user_with_shares(&ctx, 1_000_000);
    let spender = Address::generate(&ctx.env);
    let recipient = kyc_user(&ctx);

    ctx.vault().approve(&owner, &spender, &100i128, &u32::MAX);

    let owner_before = ctx.vault().balance(&owner);
    let recipient_before = ctx.vault().balance(&recipient);

    assert_panics_with(
        std::panic::AssertUnwindSafe(|| {
            ctx.vault()
                .transfer_from(&spender, &owner, &recipient, &200i128);
        }),
        19, // Error::InsufficientAllowance
    );

    assert_eq!(ctx.vault().balance(&owner), owner_before);
    assert_eq!(ctx.vault().balance(&recipient), recipient_before);
    assert_eq!(ctx.vault().allowance(&owner, &spender), 100);
}

#[test]
fn test_transfer_from_rejects_expired_allowance() {
    let ctx = setup();
    let owner = user_with_shares(&ctx, 1_000_000);
    let spender = Address::generate(&ctx.env);
    let recipient = kyc_user(&ctx);

    // Approve with the shortest possible expiry, then move past it.
    let expiry = ctx.env.ledger().sequence();
    ctx.vault().approve(&owner, &spender, &500i128, &expiry);
    ctx.env
        .ledger()
        .set_sequence_number(ctx.env.ledger().sequence() + 10);

    let owner_before = ctx.vault().balance(&owner);

    assert_panics_with(
        std::panic::AssertUnwindSafe(|| {
            ctx.vault()
                .transfer_from(&spender, &owner, &recipient, &100i128);
        }),
        19,
    );

    assert_eq!(ctx.vault().balance(&owner), owner_before);
    assert_eq!(ctx.vault().balance(&recipient), 0);
}

#[test]
fn test_burn_from_rejects_amount_above_allowance() {
    let ctx = setup();
    let owner = user_with_shares(&ctx, 1_000_000);
    let spender = Address::generate(&ctx.env);

    ctx.vault().approve(&owner, &spender, &100i128, &u32::MAX);

    let owner_before = ctx.vault().balance(&owner);

    assert_panics_with(
        std::panic::AssertUnwindSafe(|| {
            ctx.vault().burn_from(&spender, &owner, &200i128);
        }),
        19,
    );

    assert_eq!(ctx.vault().balance(&owner), owner_before);
    assert_eq!(ctx.vault().allowance(&owner, &spender), 100);
}

#[test]
fn test_burn_from_rejects_expired_allowance() {
    let ctx = setup();
    let owner = user_with_shares(&ctx, 1_000_000);
    let spender = Address::generate(&ctx.env);

    let expiry = ctx.env.ledger().sequence();
    ctx.vault().approve(&owner, &spender, &500i128, &expiry);
    ctx.env
        .ledger()
        .set_sequence_number(ctx.env.ledger().sequence() + 10);

    let owner_before = ctx.vault().balance(&owner);

    assert_panics_with(
        std::panic::AssertUnwindSafe(|| {
            ctx.vault().burn_from(&spender, &owner, &100i128);
        }),
        19,
    );

    assert_eq!(ctx.vault().balance(&owner), owner_before);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1354 — max_claimable_epoch
// ─────────────────────────────────────────────────────────────────────────────

const FUNDING_TARGET: i128 = 100_000_000;

fn activated_ctx() -> TestContext {
    let ctx = setup_with_kyc_bypass();
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, FUNDING_TARGET + 500_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 2_000_000);
    ctx.vault().deposit(&ctx.user, &FUNDING_TARGET, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);
    ctx
}

fn dist(ctx: &TestContext, amount: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, amount);
    ctx.vault().distribute_yield(&ctx.operator, &amount);
}

#[test]
fn test_max_claimable_epoch_zero_without_distributions() {
    let ctx = activated_ctx();
    assert_eq!(ctx.vault().max_claimable_epoch(&ctx.user), 0);
    assert_eq!(ctx.vault().current_epoch(), 0);
}

#[test]
fn test_max_claimable_epoch_is_latest_epoch_for_current_user() {
    let ctx = activated_ctx();
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);
    dist(&ctx, 30_000);

    assert_eq!(ctx.vault().current_epoch(), 3);
    assert_eq!(ctx.vault().max_claimable_epoch(&ctx.user), 3);

    // Claiming at or below the returned epoch succeeds.
    let claimed = ctx.vault().claim_yield_for_epoch(&ctx.user, &3);
    assert!(claimed > 0);

    // Epochs above the last distributed epoch fail.
    assert_panics_with(
        std::panic::AssertUnwindSafe(|| {
            ctx.vault().claim_yield_for_epoch(&ctx.user, &4);
        }),
        9, // Error::NoYieldToClaim
    );
}

#[test]
fn test_max_claimable_epoch_zero_after_claiming_everything() {
    let ctx = activated_ctx();
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);
    dist(&ctx, 30_000);

    ctx.vault().claim_yield(&ctx.user);
    assert_eq!(ctx.vault().max_claimable_epoch(&ctx.user), 0);
}

#[test]
fn test_max_claimable_epoch_returns_latest_unclaimed_for_behind_user() {
    let ctx = activated_ctx();
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);
    dist(&ctx, 30_000);

    // User claims only the most recent epoch; epochs 1-2 remain unclaimed.
    ctx.vault().claim_yield_for_epoch(&ctx.user, &3);

    assert_eq!(ctx.vault().max_claimable_epoch(&ctx.user), 2);

    // The returned epoch is still claimable.
    let claimed = ctx.vault().claim_yield_for_epoch(&ctx.user, &2);
    assert!(claimed > 0);

    // The already-claimed newer epoch fails.
    assert_panics_with(
        std::panic::AssertUnwindSafe(|| {
            ctx.vault().claim_yield_for_epoch(&ctx.user, &3);
        }),
        9,
    );
}
