//! Tests for set_deposit_limits, set_min_deposit, and set_max_deposit_per_user.
//!
//! Covers:
//! - Validation: negative values, min > max
//! - State guards: Funding (operator), Active (admin-only), invalid states
//! - Existing depositors are not retroactively affected when max is lowered
//! - Individual setters work independently and maintain consistency

extern crate std;

use crate::test_helpers::{advance_time, mint_usdc, setup_with_kyc_bypass};
use soroban_sdk::{testutils::Address as _, Address};

// ─────────────────────────────────────────────────────────────────────────────
// set_deposit_limits — validation
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_deposit_limits_negative_min_panics() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &-1i128, &10_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_deposit_limits_negative_max_panics() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &1_000_000i128, &-1i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_deposit_limits_min_greater_than_max_panics() {
    let ctx = setup_with_kyc_bypass();
    // min=10, max=5 is invalid when both are non-zero
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &10_000_000i128, &5_000_000i128);
}

/// When max is 0 (unlimited) any min is valid.
#[test]
fn test_set_deposit_limits_max_zero_allows_any_min() {
    let ctx = setup_with_kyc_bypass();
    // max=0 means no cap, so a positive min is fine
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &5_000_000i128, &0i128);
    assert_eq!(ctx.vault().min_deposit(), 5_000_000i128);
    assert_eq!(ctx.vault().max_deposit_per_user(), 0i128);
}

/// When min is 0 (no minimum) any max is valid.
#[test]
fn test_set_deposit_limits_min_zero_allows_any_max() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &0i128, &2_000_000i128);
    assert_eq!(ctx.vault().min_deposit(), 0i128);
    assert_eq!(ctx.vault().max_deposit_per_user(), 2_000_000i128);
}

/// min == max is valid (exact-amount deposits only).
#[test]
fn test_set_deposit_limits_min_equals_max_is_valid() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &5_000_000i128, &5_000_000i128);
    assert_eq!(ctx.vault().min_deposit(), 5_000_000i128);
    assert_eq!(ctx.vault().max_deposit_per_user(), 5_000_000i128);
}

// ─────────────────────────────────────────────────────────────────────────────
// set_deposit_limits — state guards
// ─────────────────────────────────────────────────────────────────────────────

/// Operator can update limits during Funding state.
#[test]
fn test_set_deposit_limits_funding_state_operator_succeeds() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &500_000i128, &20_000_000i128);
    assert_eq!(ctx.vault().min_deposit(), 500_000i128);
    assert_eq!(ctx.vault().max_deposit_per_user(), 20_000_000i128);
}

/// Non-operator cannot update limits.
#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_set_deposit_limits_non_operator_panics() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_deposit_limits(&ctx.user, &500_000i128, &20_000_000i128);
}

/// Admin can update limits during Active state.
#[test]
fn test_set_deposit_limits_active_state_admin_succeeds() {
    let ctx = setup_with_kyc_bypass();
    // Fund to meet 100 USDC target — two users at 50 USDC each (max per user)
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);

    ctx.vault()
        .set_deposit_limits(&ctx.admin, &500_000i128, &60_000_000i128);
    assert_eq!(ctx.vault().min_deposit(), 500_000i128);
}

/// Operator (non-admin) cannot update limits in Active state.
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_set_deposit_limits_active_state_operator_panics() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);

    // operator is not admin — must panic with NotAdmin
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &500_000i128, &60_000_000i128);
}

/// set_deposit_limits is blocked in Matured state.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_deposit_limits_matured_state_panics() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);
    advance_time(&ctx.env, 9_999_999_999u64);
    ctx.vault().mature_vault(&ctx.admin);

    ctx.vault()
        .set_deposit_limits(&ctx.admin, &500_000i128, &60_000_000i128);
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing depositors not retroactively affected
// ─────────────────────────────────────────────────────────────────────────────

/// Lowering max_deposit_per_user below an existing depositor's balance must not
/// alter their existing position — only new deposits over the new cap are blocked.
#[test]
fn test_lowering_max_does_not_affect_existing_depositor() {
    let ctx = setup_with_kyc_bypass();

    // User deposits 30 USDC (within the default 50 USDC cap)
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 30_000_000);
    ctx.vault().deposit(&ctx.user, &30_000_000i128, &ctx.user);

    let shares_before = ctx.vault().balance(&ctx.user);
    assert!(shares_before > 0);

    // Operator lowers cap to 10 USDC (below what user already deposited)
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &1_000_000i128, &10_000_000i128);

    // Existing shares are unchanged
    assert_eq!(ctx.vault().balance(&ctx.user), shares_before);
    assert_eq!(ctx.vault().user_deposited(&ctx.user), 30_000_000i128);
}

/// After max is lowered, new deposits that would exceed the new cap are rejected.
#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_new_deposit_blocked_after_max_lowered() {
    let ctx = setup_with_kyc_bypass();

    // First deposit: 5 USDC
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 15_000_000);
    ctx.vault().deposit(&ctx.user, &5_000_000i128, &ctx.user);

    // Lower max to 8 USDC; user has deposited 5 USDC so far, 3 USDC headroom
    ctx.vault()
        .set_deposit_limits(&ctx.operator, &1_000_000i128, &8_000_000i128);

    // Attempt a 5 USDC deposit — total would be 10 USDC, over the 8 USDC cap
    ctx.vault().deposit(&ctx.user, &5_000_000i128, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// set_min_deposit — individual setter
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_min_deposit_succeeds_in_funding() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_min_deposit(&ctx.operator, &500_000i128);
    assert_eq!(ctx.vault().min_deposit(), 500_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_min_deposit_negative_panics() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_min_deposit(&ctx.operator, &-1i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_min_deposit_above_existing_max_panics() {
    let ctx = setup_with_kyc_bypass();
    // Set max to 50_000_000 first, then try to set min to 60_000_000
    ctx.vault()
        .set_max_deposit_per_user(&ctx.operator, &50_000_000i128);
    ctx.vault().set_min_deposit(&ctx.operator, &60_000_000i128);
}

#[test]
fn test_set_min_deposit_zero_is_valid() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_min_deposit(&ctx.operator, &0i128);
    assert_eq!(ctx.vault().min_deposit(), 0i128);
}

// ─────────────────────────────────────────────────────────────────────────────
// set_max_deposit_per_user — individual setter
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_max_deposit_per_user_succeeds_in_funding() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault()
        .set_max_deposit_per_user(&ctx.operator, &20_000_000i128);
    assert_eq!(ctx.vault().max_deposit_per_user(), 20_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_max_deposit_per_user_negative_panics() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_max_deposit_per_user(&ctx.operator, &-1i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #33)")]
fn test_set_max_deposit_per_user_below_existing_min_panics() {
    let ctx = setup_with_kyc_bypass();
    // Default min is 1_000_000; try to set max to 500_000
    ctx.vault()
        .set_max_deposit_per_user(&ctx.operator, &500_000i128);
}

/// max=0 (unlimited) is always valid, even when min is set.
#[test]
fn test_set_max_deposit_per_user_zero_removes_cap() {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_max_deposit_per_user(&ctx.operator, &0i128);
    assert_eq!(ctx.vault().max_deposit_per_user(), 0i128);
}

/// Operator cannot call set_max_deposit_per_user in Active state; only admin.
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_set_max_deposit_per_user_active_operator_panics() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);

    ctx.vault()
        .set_max_deposit_per_user(&ctx.operator, &20_000_000i128);
}

/// set_max_deposit_per_user is blocked in Matured state.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_max_deposit_per_user_matured_panics() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);
    advance_time(&ctx.env, 9_999_999_999u64);
    ctx.vault().mature_vault(&ctx.admin);

    ctx.vault()
        .set_max_deposit_per_user(&ctx.admin, &20_000_000i128);
}

/// set_min_deposit is blocked in Matured state.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_set_min_deposit_matured_panics() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);
    advance_time(&ctx.env, 9_999_999_999u64);
    ctx.vault().mature_vault(&ctx.admin);

    ctx.vault().set_min_deposit(&ctx.admin, &500_000i128);
}

/// Admin can use set_min_deposit in Active state.
#[test]
fn test_set_min_deposit_active_state_admin_succeeds() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 50_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 50_000_000);
    ctx.vault().deposit(&ctx.user, &50_000_000i128, &ctx.user);
    ctx.vault().deposit(&user2, &50_000_000i128, &user2);
    ctx.vault().activate_vault(&ctx.admin);

    ctx.vault().set_min_deposit(&ctx.admin, &500_000i128);
    assert_eq!(ctx.vault().min_deposit(), 500_000i128);
}
