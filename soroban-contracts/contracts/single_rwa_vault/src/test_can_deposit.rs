use crate::errors::Error as VaultError;
use crate::test_helpers::{setup, MockZkmeClient, TestContext};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, String, Vec,
};

fn approve_kyc(ctx: &TestContext, user: &Address) {
    MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(user);
}

#[test]
fn can_deposit_paused() {
    let ctx = setup();
    let vault = ctx.vault();
    approve_kyc(&ctx, &ctx.user);
    vault.pause(&ctx.admin, &String::from_str(&ctx.env, "test pause"));

    let result = vault.can_deposit(&ctx.user, &10_000_000);

    assert_eq!(result.user, ctx.user);
    assert_eq!(result.status_code, VaultError::VaultPaused as u32);
    assert_eq!(result.expected_shares, 0);
}

#[test]
fn can_deposit_below_minimum() {
    let ctx = setup();
    let vault = ctx.vault();
    approve_kyc(&ctx, &ctx.user);

    let result = vault.can_deposit(&ctx.user, &999_999);

    assert_eq!(result.user, ctx.user);
    assert_eq!(result.status_code, VaultError::BelowMinimumDeposit as u32);
    assert_eq!(result.expected_shares, 0);
}

#[test]
fn can_deposit_above_per_user_cap() {
    let ctx = setup();
    let vault = ctx.vault();
    approve_kyc(&ctx, &ctx.user);
    vault.set_max_deposit_per_user(&ctx.admin, &5_000_000);

    let result = vault.can_deposit(&ctx.user, &10_000_000);

    assert_eq!(result.user, ctx.user);
    assert_eq!(result.status_code, VaultError::ExceedsMaximumDeposit as u32);
    assert_eq!(result.expected_shares, 0);
}

#[test]
fn can_deposit_missing_kyc() {
    let ctx = setup();
    let vault = ctx.vault();

    let result = vault.can_deposit(&ctx.user, &10_000_000);

    assert_eq!(result.user, ctx.user);
    assert_eq!(result.status_code, VaultError::NotKYCVerified as u32);
    assert_eq!(result.expected_shares, 0);
}

#[test]
fn can_deposit_vault_not_active() {
    let ctx = setup();
    let vault = ctx.vault();
    approve_kyc(&ctx, &ctx.user);
    ctx.env
        .ledger()
        .with_mut(|li| li.timestamp = 10_000_000_000);
    vault.cancel_funding(&ctx.admin);

    let result = vault.can_deposit(&ctx.user, &10_000_000);

    assert_eq!(result.user, ctx.user);
    assert_eq!(result.status_code, VaultError::InvalidVaultState as u32);
    assert_eq!(result.expected_shares, 0);
}

#[test]
fn can_deposit_allowed_and_deposit_succeeds() {
    let ctx = setup();
    let vault = ctx.vault();
    let asset = ctx.asset();
    approve_kyc(&ctx, &ctx.user);
    asset.mint(&ctx.user, &20_000_000);

    let result = vault.can_deposit(&ctx.user, &10_000_000);

    assert_eq!(result.user, ctx.user);
    assert_eq!(result.status_code, 0);
    assert!(result.expected_shares > 0);

    vault.deposit(&ctx.user, &10_000_000, &ctx.user);
    assert_eq!(asset.balance(&ctx.vault_id), 10_000_000);
    assert_eq!(vault.balance(&ctx.user), result.expected_shares);
}

#[test]
fn can_deposit_many_returns_one_ordered_result_per_input() {
    let ctx = setup();
    let vault = ctx.vault();
    let allowed = ctx.user.clone();
    let no_kyc = Address::generate(&ctx.env);
    let below_minimum = Address::generate(&ctx.env);
    approve_kyc(&ctx, &allowed);
    approve_kyc(&ctx, &below_minimum);

    let users = Vec::from_array(
        &ctx.env,
        [allowed.clone(), no_kyc.clone(), below_minimum.clone()],
    );
    let amounts = Vec::from_array(&ctx.env, [10_000_000i128, 10_000_000i128, 999_999i128]);
    let results = vault.can_deposit_many(&users, &amounts);

    assert_eq!(results.len(), 3);
    assert_eq!(results.get(0).unwrap().user, allowed);
    assert_eq!(results.get(1).unwrap().user, no_kyc);
    assert_eq!(results.get(2).unwrap().user, below_minimum);
    assert_eq!(results.get(0).unwrap().status_code, 0);
    assert!(results.get(0).unwrap().expected_shares > 0);
    assert_eq!(
        results.get(1).unwrap().status_code,
        VaultError::NotKYCVerified as u32
    );
    assert_eq!(results.get(1).unwrap().expected_shares, 0);
    assert_eq!(
        results.get(2).unwrap().status_code,
        VaultError::BelowMinimumDeposit as u32
    );
    assert_eq!(results.get(2).unwrap().expected_shares, 0);

    for i in 0..3 {
        let single = vault.can_deposit(&users.get_unchecked(i), &amounts.get_unchecked(i));
        let batch = results.get_unchecked(i);
        assert_eq!(single.status_code, batch.status_code);
        assert_eq!(single.expected_shares, batch.expected_shares);
    }
}

#[test]
fn can_deposit_many_returns_empty_for_empty_input() {
    let ctx = setup();
    let vault = ctx.vault();

    let results = vault.can_deposit_many(&Vec::new(&ctx.env), &Vec::new(&ctx.env));

    assert!(results.is_empty());
}

#[test]
fn can_deposit_many_tracks_batch_state_for_duplicate_users() {
    let ctx = setup();
    let vault = ctx.vault();
    approve_kyc(&ctx, &ctx.user);

    let users = Vec::from_array(&ctx.env, [ctx.user.clone(), ctx.user.clone()]);
    let amounts = Vec::from_array(&ctx.env, [60_000_000i128, 60_000_000i128]);
    let results = vault.can_deposit_many(&users, &amounts);

    assert_eq!(results.len(), 2);
    assert_eq!(results.get(0).unwrap().status_code, 0);
    assert_eq!(
        results.get(1).unwrap().status_code,
        VaultError::FundingTargetExceeded as u32
    );
}
