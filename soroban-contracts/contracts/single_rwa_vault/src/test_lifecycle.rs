//! Unit tests for SingleRWAVault lifecycle transitions.
//!
//! Verifies the state machine: Funding -> Active -> Matured.
//! Transitions require preconditions (funding target, maturity date) and guards (operator-only).

use crate::test_helpers::{advance_time, mint_usdc, setup_with_kyc_bypass};
use soroban_sdk::testutils::Ledger;

// ─────────────────────────────────────────────────────────────────────────────
// Happy Paths
// (some detailed event-emission lifecycle tests removed per request)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_is_funding_target_met() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    let target = v.funding_target();

    // Not met initially
    assert!(!v.is_funding_target_met());

    // Deposit exactly the target
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, target);
    v.deposit(&ctx.user, &target, &ctx.user);

    assert!(v.is_funding_target_met());
}

#[test]
fn test_time_to_maturity() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    let maturity = 10_000u64;
    v.set_maturity_date(&ctx.operator, &maturity);

    ctx.env.ledger().with_mut(|li| li.timestamp = 1000);
    assert_eq!(v.time_to_maturity(), 9000);

    advance_time(&ctx.env, 5000);
    assert_eq!(v.time_to_maturity(), 4000);

    advance_time(&ctx.env, 4000);
    assert_eq!(v.time_to_maturity(), 0);

    advance_time(&ctx.env, 1000);
    assert_eq!(v.time_to_maturity(), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Paths
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Contract, #10)")] // FundingTargetNotMet
fn test_activate_insufficient_funding() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    // Deposit less than target (100 USDC)
    let amount = 50_000_000i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, amount);
    v.deposit(&ctx.user, &amount, &ctx.user);

    assert!(!v.is_funding_target_met());

    // Attempt activation should panic
    v.activate_vault(&ctx.operator);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #3)")] // NotAuthorized
fn test_operator_only_guards() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    // Non-operator (user) tries to set maturity date
    v.set_maturity_date(&ctx.user, &2_000_000_000u64);
}
