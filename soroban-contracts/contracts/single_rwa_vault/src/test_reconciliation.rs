//! Tests for off-chain yield reconciliation view functions.

extern crate std;

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass, TestContext};

fn deposit(ctx: &TestContext, user: &soroban_sdk::Address, assets: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, user, assets);
    ctx.vault().deposit(user, &assets, user);
}

fn activate(ctx: &TestContext) {
    // Ensure funding target is reachable in tests.
    let current = ctx.vault().total_assets();
    if current < ctx.params.funding_target {
        ctx.vault().set_funding_target(&ctx.admin, &current);
    }
    ctx.vault().activate_vault(&ctx.admin);
}

fn distribute_yield(ctx: &TestContext, amount: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, amount);
    ctx.vault().distribute_yield(&ctx.admin, &amount);
}

#[test]
fn test_get_yield_reconciliation_empty_vault() {
    let ctx = setup_with_kyc_bypass();

    let rec = ctx.vault().get_yield_reconciliation();
    assert_eq!(rec.total_yield_distributed, 0);
    assert_eq!(rec.total_yield_claimed, 0);
    assert_eq!(rec.total_yield_unclaimed, 0);
    assert_eq!(rec.vault_asset_balance, 0);
    assert_eq!(rec.total_principal_deposited, 0);
    assert_eq!(rec.balance_discrepancy, 0);
}

#[test]
fn test_get_yield_reconciliation_and_user_position_multi_user_multi_epoch() {
    let ctx = setup_with_kyc_bypass();

    // Two users deposit 10 and 30 (units = 6-decimal USDC).
    deposit(&ctx, &ctx.user, 10_000_000);
    let user_b = soroban_sdk::Address::generate(&ctx.env);
    deposit(&ctx, &user_b, 30_000_000);

    activate(&ctx);

    // Distribute yield twice.
    distribute_yield(&ctx, 4_000_000);
    distribute_yield(&ctx, 6_000_000);

    // User A claims yield; user B leaves it pending.
    let claimed_a = ctx.vault().claim_yield(&ctx.user);
    assert!(claimed_a > 0);

    let rec = ctx.vault().get_yield_reconciliation();
    assert_eq!(rec.total_yield_distributed, 10_000_000);
    assert_eq!(rec.total_yield_unclaimed, rec.total_yield_distributed - rec.total_yield_claimed);

    // Basic invariant: balance discrepancy should be zero under normal operation.
    assert_eq!(
        rec.balance_discrepancy, 0,
        "vault accounting should reconcile under normal operations"
    );

    // User position fields are public and consistent.
    let pos_a = ctx.vault().get_user_position(&ctx.user);
    let pos_b = ctx.vault().get_user_position(&user_b);

    assert_eq!(pos_a.total_yield_claimed, claimed_a);
    assert!(pos_a.pending_yield >= 0);
    assert!(pos_b.pending_yield > 0);

    // Ownership percentage sums to ~10_000 bps (allow 1 bp rounding slack).
    let total_bps = pos_a.share_percentage + pos_b.share_percentage;
    assert!(
        (9_999..=10_001).contains(&total_bps),
        "share_percentage should sum to ~10_000 bps"
    );
}

