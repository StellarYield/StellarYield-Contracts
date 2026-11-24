//! Tests that burn is blocked while the caller has unclaimed yield (#1361).

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass};

fn activate(deposit: i128) -> crate::test_helpers::TestContext {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_funding_target(&ctx.operator, &deposit);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, deposit * 2);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, deposit * 10);
    ctx.vault().deposit(&ctx.user, &deposit, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);
    ctx
}

#[test]
#[should_panic(expected = "Error(Contract, #32)")]
fn test_burn_blocked_with_pending_yield() {
    let ctx = activate(1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 100_000);
    ctx.vault().distribute_yield(&ctx.operator, &100_000i128);

    // User has unclaimed yield — burn must panic with #32.
    ctx.vault().burn(&ctx.user, &500_000i128);
}

#[test]
fn test_burn_allowed_after_claim() {
    let ctx = activate(1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 100_000);
    ctx.vault().distribute_yield(&ctx.operator, &100_000i128);

    ctx.vault().claim_yield(&ctx.user);

    // No pending yield — burn must succeed.
    ctx.vault().burn(&ctx.user, &500_000i128);
}

#[test]
fn test_burn_allowed_with_no_yield_distributed() {
    let ctx = activate(1_000_000);
    // No yield distributed → pending_yield == 0 → burn succeeds.
    ctx.vault().burn(&ctx.user, &500_000i128);
}
