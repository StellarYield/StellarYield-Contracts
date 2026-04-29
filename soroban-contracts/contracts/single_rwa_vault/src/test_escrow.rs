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
#[ignore = "storage bug"]
fn test_early_redemption_escrow_and_transfer_lock() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    // 1. Setup user with shares
    let deposit_amount = 10_000_000i128; // 10 USDC
    fund_and_approve(&ctx, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);

    // 2. Activate vault
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    let initial_balance = v.balance(&ctx.user);
    assert_eq!(initial_balance, deposit_amount);
    assert_eq!(v.escrowed_balance(&ctx.user), 0);

    // Record vault token balance before request
    let asset = ctx.asset();
    let vault_token_balance_before = asset.balance(&ctx.vault_id);

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

    // Verify request is marked as processed after cancellation
    let req = v.redemption_request(&request_id);
    assert!(req.processed);

    // Verify vault's token balance is unchanged (cancellation only affects shares, not tokens)
    let vault_token_balance_after = asset.balance(&ctx.vault_id);
    assert_eq!(vault_token_balance_after, vault_token_balance_before);
}

#[test]
#[ignore = "storage bug"]
fn test_early_redemption_process_burns_from_escrow() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    // Setup
    let deposit_amount = 10_000_000i128;
    fund_and_approve(&ctx, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    let request_shares = 10_000_000i128;
    let request_id = v.request_early_redemption(&ctx.user, &request_shares);

    let supply_before = v.total_supply();
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(v.escrowed_balance(&ctx.user), request_shares);

    // Record asset balances before processing
    let asset = ctx.asset();
    let user_token_balance_before = asset.balance(&ctx.user);
    let vault_token_balance_before = asset.balance(&ctx.vault_id);

    // Calculate expected refund amount after fee (default fee: 200 bps = 2%)
    let assets = request_shares; // 1:1 share-to-asset ratio at start
    let fee_bps = 200i128;
    let fee = (assets * fee_bps) / 10000;
    let expected_net_assets = assets - fee;

    // Process
    v.process_early_redemption(&ctx.operator, &request_id);

    // Verify shares are burned from escrow
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(v.escrowed_balance(&ctx.user), 0);
    assert_eq!(v.total_supply(), supply_before - request_shares);

    let req = v.redemption_request(&request_id);
    assert!(req.processed);

    // Verify exact refund amount: user receives (assets - fee)
    let user_token_balance_after = asset.balance(&ctx.user);
    assert_eq!(
        user_token_balance_after,
        user_token_balance_before + expected_net_assets,
        "User did not receive exact refund amount after fee"
    );

    // Verify vault's internal accounting: token balance decreased by net_assets only (fee stays)
    let vault_token_balance_after = asset.balance(&ctx.vault_id);
    assert_eq!(
        vault_token_balance_after,
        vault_token_balance_before - expected_net_assets,
        "Vault token balance does not match expected post-refund state"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")] // AlreadyProcessed
#[ignore = "storage bug"]
fn test_cannot_cancel_twice() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    fund_and_approve(&ctx, &ctx.user, 10_000_000);
    v.deposit(&ctx.user, &10_000_000i128, &ctx.user);
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    let request_id = v.request_early_redemption(&ctx.user, &5_000_000);
    v.cancel_early_redemption(&ctx.user, &request_id);
    v.cancel_early_redemption(&ctx.user, &request_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")] // AlreadyProcessed
#[ignore = "storage bug"]
fn test_cannot_process_cancelled() {
    let ctx = setup();
    let v = ctx.vault();
    let _e = &ctx.env;

    fund_and_approve(&ctx, &ctx.user, 10_000_000);
    v.deposit(&ctx.user, &10_000_000i128, &ctx.user);
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    let request_id = v.request_early_redemption(&ctx.user, &5_000_000);
    v.cancel_early_redemption(&ctx.user, &request_id);
    v.process_early_redemption(&ctx.operator, &request_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: underfunded escrow/refund behavior (issue #212)
// When funding target is not met and deadline passes, cancel_funding transitions
// to Cancelled state and users can refund their deposits 1:1.
// ─────────────────────────────────────────────────────────────────────────────

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient, VaultState};

use crate::test_helpers::{AlwaysApproveZkme, MockUsdc, MockUsdcClient};

/// Deploy a vault with a short funding_deadline for underfunding tests.
fn deploy_underfunded(funding_deadline: u64) -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let cooperator = Address::generate(&env);

    let asset_id = env.register(MockUsdc, ());
    let kyc_id = env.register(AlwaysApproveZkme, ());

    let params = InitParams {
        yield_vesting_period: 0,
        asset: asset_id.clone(),
        share_name: String::from_str(&env, "StellarYield Bond Share"),
        share_symbol: String::from_str(&env, "syBOND"),
        share_decimals: 6u32,
        admin: admin.clone(),
        zkme_verifier: kyc_id.clone(),
        cooperator: cooperator.clone(),
        funding_target: 100_000_000i128, // 100 USDC
        maturity_date: 9_999_999_999u64,
        funding_deadline,
        min_deposit: 1_000_000i128,  // 1 USDC
        max_deposit_per_user: 0i128, // unlimited
        early_redemption_fee_bps: 200u32,
        operator_fee_bps: 0u32,
        rwa_name: String::from_str(&env, "US Treasury Bond 2026"),
        rwa_symbol: String::from_str(&env, "USTB26"),
        rwa_document_uri: String::from_str(&env, "https://example.com/ustb26"),
        rwa_category: String::from_str(&env, "Government Bond"),
        expected_apy: 500u32,
        timelock_delay: 172800u64, // 48 hours
        yield_vesting_period: 0u64,
    };

    let vault_id = env.register(SingleRWAVault, (params,));
    (env, vault_id, asset_id, admin, user1, user2)
}

/// Test: two users deposit below the funding target, deadline passes, cancel_funding,
/// then each user refunds and receives exactly their deposit back.
#[test]
fn test_underfunded_escrow_refund_behavior() {
    let deadline = 1_000u64;
    let (env, vault_id, asset_id, admin, user1, user2) = deploy_underfunded(deadline);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let asset = MockUsdcClient::new(&env, &asset_id);

    // Each user deposits 10 USDC (total = 20 USDC < 100 USDC target).
    let deposit1 = 10_000_000i128;
    let deposit2 = 10_000_000i128;

    asset.mint(&user1, &deposit1);
    asset.mint(&user2, &deposit2);
    vault.deposit(&user1, &deposit1, &user1);
    vault.deposit(&user2, &deposit2, &user2);

    // Verify vault is still in Funding state.
    assert_eq!(vault.vault_state(), VaultState::Funding);

    // Record balances before cancellation.
    let user1_bal_before = asset.balance(&user1);
    let user2_bal_before = asset.balance(&user2);
    let vault_bal_before = asset.balance(&vault_id);

    // Advance past deadline and cancel funding.
    env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&admin);
    assert_eq!(vault.vault_state(), VaultState::Cancelled);

    // User 1 refunds.
    let returned1 = vault.refund(&user1);
    let user1_bal_after = asset.balance(&user1);
    assert_eq!(returned1, deposit1, "User 1 refund amount mismatch");
    assert_eq!(
        user1_bal_after - user1_bal_before,
        deposit1,
        "User 1 token balance did not increase by deposit amount"
    );
    assert_eq!(
        vault.balance(&user1),
        0,
        "User 1 share balance should be 0 after refund"
    );

    // User 2 refunds.
    let returned2 = vault.refund(&user2);
    let user2_bal_after = asset.balance(&user2);
    assert_eq!(returned2, deposit2, "User 2 refund amount mismatch");
    assert_eq!(
        user2_bal_after - user2_bal_before,
        deposit2,
        "User 2 token balance did not increase by deposit amount"
    );
    assert_eq!(
        vault.balance(&user2),
        0,
        "User 2 share balance should be 0 after refund"
    );

    // Verify vault token balance decreased by exactly the total deposits.
    let vault_bal_after = asset.balance(&vault_id);
    assert_eq!(
        vault_bal_before - vault_bal_after,
        deposit1 + deposit2,
        "Vault token balance decrease does not match total deposits"
    );

    // Verify total supply is 0 after all refunds.
    assert_eq!(
        vault.total_supply(),
        0,
        "Total supply should be 0 after all refunds"
    );
}

/// Test: single user deposits below target, deadline passes, cancel_funding,
/// refund returns exact deposit amount, and double-refund is prevented.
#[test]
fn test_underfunded_single_user_refund_and_double_refund_prevented() {
    let deadline = 1_000u64;
    let (env, vault_id, asset_id, admin, user1, _user2) = deploy_underfunded(deadline);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let asset = MockUsdcClient::new(&env, &asset_id);

    let deposit = 5_000_000i128; // 5 USDC (well below 100 USDC target)

    asset.mint(&user1, &deposit);
    vault.deposit(&user1, &deposit, &user1);

    // Advance past deadline and cancel funding.
    env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&admin);
    assert_eq!(vault.vault_state(), VaultState::Cancelled);

    // Record balance before refund.
    let user1_bal_before = asset.balance(&user1);

    // First refund succeeds.
    let returned = vault.refund(&user1);
    assert_eq!(returned, deposit, "Refund amount should equal deposit");
    let user1_bal_after = asset.balance(&user1);
    assert_eq!(
        user1_bal_after - user1_bal_before,
        deposit,
        "User token balance should increase by deposit amount"
    );
    assert_eq!(
        vault.balance(&user1),
        0,
        "Share balance should be 0 after refund"
    );

    // Second refund should panic with NoSharesToRefund.
    // (We cannot use #[should_panic] here because we need setup logic before the panic,
    //  so we catch the panic via a manual check.)
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.refund(&user1);
    }));
    assert!(result.is_err(), "Double refund should panic");
}
