//! Tests for correct yield attribution after burn operations (#99).

extern crate std;

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass};

fn activate_with_deposit(deposit: i128) -> crate::test_helpers::TestContext {
    let ctx = setup_with_kyc_bypass();
    // Lower the funding target to exactly `deposit` so activation succeeds.
    ctx.vault().set_funding_target(&ctx.operator, &deposit);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, deposit * 2);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, deposit * 10);
    ctx.vault().deposit(&ctx.user, &deposit, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);
    ctx
}

fn distribute(ctx: &crate::test_helpers::TestContext, amount: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, amount);
    ctx.vault().distribute_yield(&ctx.operator, &amount);
}

/// Verify that `burn` correctly snapshots the user's balance before reducing it,
/// so that pending yield for the current epoch is attributed to the pre-burn balance.
#[test]
fn test_burn_snapshots_before_balance_change() {
    let ctx = activate_with_deposit(1_000_000);

    // Distribute epoch 1
    distribute(&ctx, 100_000);

    // User burns half their shares; snapshot for epoch 1 should be recorded first
    ctx.vault().burn(&ctx.user, &500_000i128);

    // Pending yield for epoch 1 should still reflect 1_000_000 shares (pre-burn)
    let pending = ctx.vault().pending_yield_for_epoch(&ctx.user, &1u32);
    assert_eq!(pending, 100_000, "yield should use pre-burn share count");
}

/// Verify that `burn_from` also snapshots the owner's balance before burning.
#[test]
fn test_burn_from_snapshots_before_balance_change() {
    let ctx = activate_with_deposit(1_000_000);

    distribute(&ctx, 100_000);

    // Approve spender and burn via burn_from
    let spender = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&ctx.env);
    ctx.vault()
        .approve(&ctx.user, &spender, &500_000i128, &1000u32);
    ctx.vault().burn_from(&spender, &ctx.user, &500_000i128);

    let pending = ctx.vault().pending_yield_for_epoch(&ctx.user, &1u32);
    assert_eq!(pending, 100_000, "yield should use pre-burn share count");
}

/// After a burn, future epochs correctly use the reduced balance.
#[test]
#[ignore = "storage bug"]
fn test_burn_future_epoch_uses_reduced_balance() {
    let ctx = activate_with_deposit(1_000_000);

    // Epoch 1
    distribute(&ctx, 100_000);

    // Burn half
    ctx.vault().burn(&ctx.user, &500_000i128);

    // Epoch 2 — only 500_000 shares remain
    distribute(&ctx, 100_000);

    let pending_e2 = ctx.vault().pending_yield_for_epoch(&ctx.user, &2u32);
    assert_eq!(
        pending_e2, 100_000,
        "epoch 2 yield should reflect post-burn balance (user holds all remaining shares)"
    );
}
