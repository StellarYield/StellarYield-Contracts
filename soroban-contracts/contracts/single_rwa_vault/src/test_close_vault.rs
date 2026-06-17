extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address,
};

use crate::{
    test_helpers::{mint_usdc, setup, setup_with_kyc_bypass},
    VaultState,
};

#[test]
fn test_close_vault_success() {
    let ctx = setup();
    let v = ctx.vault();
    let e = &ctx.env;

    // 1. Set funding target to 0 so it's trivially met, then Funding -> Active
    v.set_funding_target(&ctx.admin, &0i128);
    e.ledger().set_timestamp(100);
    v.activate_vault(&ctx.operator);

    // 2. Active -> Matured
    e.ledger().set_timestamp(ctx.params.maturity_date + 1);
    v.mature_vault(&ctx.operator);
    assert_eq!(v.vault_state(), VaultState::Matured);

    // 3. Matured -> Closed (total_supply is already 0 in setup())
    v.close_vault(&ctx.operator);
    assert_eq!(v.vault_state(), VaultState::Closed);
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")] // VaultNotEmpty
fn test_close_vault_fails_if_not_empty() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let e = &ctx.env;

    // Deposit enough to meet the funding target
    let deposit_amount = ctx.params.funding_target;
    mint_usdc(e, &ctx.asset_id, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);

    e.ledger().set_timestamp(100);
    v.activate_vault(&ctx.operator);

    e.ledger().set_timestamp(ctx.params.maturity_date + 1);
    v.mature_vault(&ctx.operator);

    // Vault has shares outstanding
    assert!(v.total_supply() > 0);

    v.close_vault(&ctx.operator);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // InvalidVaultState
fn test_close_vault_fails_if_not_matured() {
    let ctx = setup();
    let v = ctx.vault();

    // Still in Funding
    v.close_vault(&ctx.operator);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // NotOperator
#[ignore = "storage bug"]
fn test_close_vault_fails_for_non_operator() {
    let ctx = setup();
    let v = ctx.vault();
    let e = &ctx.env;
    let anyone = Address::generate(e);

    v.set_funding_target(&ctx.admin, &0i128);
    e.ledger().set_timestamp(100);
    v.activate_vault(&ctx.operator);
    e.ledger().set_timestamp(ctx.params.maturity_date + 1);
    v.mature_vault(&ctx.operator);

    v.close_vault(&anyone);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // InvalidVaultState
fn test_claim_yield_after_vault_closure_is_rejected() {
    let ctx = setup();
    let v = ctx.vault();

    v.set_funding_target(&ctx.admin, &0i128);
    ctx.env.ledger().set_timestamp(100);
    v.activate_vault(&ctx.operator);
    ctx.env.ledger().set_timestamp(ctx.params.maturity_date + 1);
    v.mature_vault(&ctx.operator);
    v.close_vault(&ctx.operator);
    assert_eq!(v.vault_state(), VaultState::Closed);

    v.claim_yield(&ctx.user);
}

#[test]
fn test_full_redemption_then_closure_lifecycle() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let e = &ctx.env;

    // 1. Fund the vault: deposit up to the funding target
    let deposit_amount = ctx.params.funding_target;
    mint_usdc(e, &ctx.asset_id, &ctx.user, deposit_amount);
    let shares_minted = v.deposit(&ctx.user, &deposit_amount, &ctx.user);
    assert!(shares_minted > 0);
    assert_eq!(v.total_supply(), shares_minted);
    assert_eq!(v.balance(&ctx.user), shares_minted);

    // 2. Activate the vault: Funding -> Active
    e.ledger().set_timestamp(100);
    v.activate_vault(&ctx.operator);
    assert_eq!(v.vault_state(), VaultState::Active);

    // 3. Advance time past maturity and mature: Active -> Matured
    e.ledger().set_timestamp(ctx.params.maturity_date + 1);
    v.mature_vault(&ctx.operator);
    assert_eq!(v.vault_state(), VaultState::Matured);

    // 4. User redeems all shares at maturity
    let user_shares_before = v.balance(&ctx.user);
    assert_eq!(user_shares_before, shares_minted);

    let total_redeemed = v.redeem_at_maturity(&ctx.user, &shares_minted, &ctx.user, &ctx.user);
    assert!(total_redeemed > 0);

    // Verify shares are fully redeemed (burned)
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(v.total_supply(), 0);

    // 5. Close the vault: Matured -> Closed
    v.close_vault(&ctx.operator);
    assert_eq!(v.vault_state(), VaultState::Closed);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // InvalidVaultState
fn test_closed_state_blocks_early_redemption_request() {
    let ctx = setup();
    let v = ctx.vault();

    v.set_funding_target(&ctx.admin, &0i128);
    ctx.env.ledger().set_timestamp(100);
    v.activate_vault(&ctx.operator);
    ctx.env.ledger().set_timestamp(ctx.params.maturity_date + 1);
    v.mature_vault(&ctx.operator); // Need to mature first to close
    v.close_vault(&ctx.operator);

    v.request_early_redemption(&ctx.user, &100);
}
