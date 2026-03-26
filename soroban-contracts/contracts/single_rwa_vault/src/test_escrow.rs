extern crate std;

use soroban_sdk::Address;

use crate::test_helpers::{mint_usdc, setup, TestContext};

fn fund_and_approve(ctx: &TestContext, user: &Address, amount: i128) {
    let e = &ctx.env;
    // Approve in zkMe
    let zkme_client = crate::test_helpers::MockZkmeClient::new(e, &ctx.kyc_id);
    zkme_client.approve_user(user);
    // Mint tokens
    mint_usdc(e, &ctx.asset_id, user, amount);
}

#[test]
fn test_early_redemption_escrow_and_transfer_lock() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    // 1. Setup user with shares
    let deposit_amount = 10_000_000i128; // 10 USDC
    fund_and_approve(&ctx, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);

    // 2. Activate vault
    v.activate_vault(&ctx.operator);

    let initial_balance = v.balance(&ctx.user);
    assert_eq!(initial_balance, deposit_amount);
    assert_eq!(v.escrowed_balance(&ctx.user), 0);

    // 3. Request early redemption for half
    let request_shares = 5_000_000i128;
    let request_id = v.request_early_redemption(&ctx.user, &request_shares);

    // 4. Verify shares are escrowed
    assert_eq!(v.balance(&ctx.user), initial_balance - request_shares);
    assert_eq!(v.escrowed_balance(&ctx.user), request_shares);

    // 5. Cancel redemption
    v.cancel_early_redemption(&ctx.user, &request_id);
    assert_eq!(v.balance(&ctx.user), initial_balance);
    assert_eq!(v.escrowed_balance(&ctx.user), 0);

    let req = v.redemption_request(&request_id);
    assert!(req.processed);
}

#[test]
fn test_early_redemption_process_burns_from_escrow() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    // Setup
    let deposit_amount = 10_000_000i128;
    fund_and_approve(&ctx, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);
    v.activate_vault(&ctx.operator);

    let request_shares = 10_000_000i128;
    let request_id = v.request_early_redemption(&ctx.user, &request_shares);

    let supply_before = v.total_supply();
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(v.escrowed_balance(&ctx.user), request_shares);

    // Process
    v.process_early_redemption(&ctx.operator, &request_id);

    // Verify
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(v.escrowed_balance(&ctx.user), 0);
    assert_eq!(v.total_supply(), supply_before - request_shares);

    let req = v.redemption_request(&request_id);
    assert!(req.processed);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")] // AlreadyProcessed
fn test_cannot_cancel_twice() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    fund_and_approve(&ctx, &ctx.user, 10_000_000);
    v.deposit(&ctx.user, &10_000_000i128, &ctx.user);
    v.activate_vault(&ctx.operator);

    let request_id = v.request_early_redemption(&ctx.user, &5_000_000);
    v.cancel_early_redemption(&ctx.user, &request_id);
    v.cancel_early_redemption(&ctx.user, &request_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")] // AlreadyProcessed
fn test_cannot_process_cancelled() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    fund_and_approve(&ctx, &ctx.user, 10_000_000);
    v.deposit(&ctx.user, &10_000_000i128, &ctx.user);
    v.activate_vault(&ctx.operator);

    let request_id = v.request_early_redemption(&ctx.user, &5_000_000);
    v.cancel_early_redemption(&ctx.user, &request_id);
    v.process_early_redemption(&ctx.operator, &request_id);
}
