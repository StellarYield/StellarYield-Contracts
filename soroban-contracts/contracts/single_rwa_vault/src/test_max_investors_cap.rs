//! Tests that the vault enforces the max_investors cap on deposit (#1366).

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass};

fn activate_with_cap(cap: u32, seed_deposit: i128) -> crate::test_helpers::TestContext {
    let ctx = setup_with_kyc_bypass();
    ctx.vault().set_funding_target(&ctx.operator, &(seed_deposit * cap as i128));
    ctx.vault().set_max_investors(&ctx.admin, &cap);
    ctx.vault().activate_vault(&ctx.operator);
    ctx
}

fn new_depositor(ctx: &crate::test_helpers::TestContext, amount: i128) -> Address {
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, amount);
    user
}

#[test]
fn test_deposit_up_to_cap_succeeds() {
    let ctx = setup_with_kyc_bypass();
    let deposit = 100_000i128;
    ctx.vault().set_funding_target(&ctx.operator, &(deposit * 3));
    ctx.vault().set_max_investors(&ctx.admin, &3u32);

    for _ in 0..3u32 {
        let user = new_depositor(&ctx, deposit);
        ctx.vault().deposit(&user, &deposit, &user);
    }

    ctx.vault().activate_vault(&ctx.operator);
    assert_eq!(ctx.vault().investor_count(), 3u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #53)")]
fn test_deposit_over_cap_panics() {
    let ctx = setup_with_kyc_bypass();
    let deposit = 100_000i128;
    ctx.vault().set_funding_target(&ctx.operator, &(deposit * 10));
    ctx.vault().set_max_investors(&ctx.admin, &2u32);

    // Fill the cap.
    for _ in 0..2u32 {
        let user = new_depositor(&ctx, deposit);
        ctx.vault().deposit(&user, &deposit, &user);
    }

    ctx.vault().activate_vault(&ctx.operator);

    // One more new investor — must panic with #53.
    let extra = new_depositor(&ctx, deposit);
    ctx.vault().deposit(&extra, &deposit, &extra);
}

#[test]
fn test_zero_cap_means_unlimited() {
    let ctx = setup_with_kyc_bypass();
    let deposit = 100_000i128;
    ctx.vault().set_funding_target(&ctx.operator, &(deposit * 10));
    ctx.vault().set_max_investors(&ctx.admin, &0u32); // 0 = unlimited

    for _ in 0..5u32 {
        let user = new_depositor(&ctx, deposit);
        ctx.vault().deposit(&user, &deposit, &user);
    }

    ctx.vault().activate_vault(&ctx.operator);
    assert_eq!(ctx.vault().investor_count(), 5u32);
}

#[test]
fn test_existing_investor_redeposit_does_not_count_twice() {
    let ctx = setup_with_kyc_bypass();
    let deposit = 100_000i128;
    ctx.vault().set_funding_target(&ctx.operator, &(deposit * 10));
    ctx.vault().set_max_investors(&ctx.admin, &2u32);

    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, deposit * 2);
    ctx.vault().deposit(&ctx.user, &deposit, &ctx.user);

    // Same user deposits again — should not increment investor count again.
    ctx.vault().deposit(&ctx.user, &deposit, &ctx.user);

    ctx.vault().activate_vault(&ctx.operator);
    assert_eq!(ctx.vault().investor_count(), 1u32);
}
