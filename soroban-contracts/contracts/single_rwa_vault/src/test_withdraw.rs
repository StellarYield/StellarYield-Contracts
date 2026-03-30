//! Unit tests for withdraw and redeem operations on SingleRWAVault.
//!
//! Covers:
//!  - Happy paths: withdraw by exact assets, redeem by exact shares
//!  - Allowance paths: a spender acting on an owner's behalf
//!  - Error paths: insufficient allowance, insufficient shares, vault paused
//!  - Edge cases: drain entire balance, non-1:1 share price validation

use crate::test_helpers::{mint_usdc, normalize_amount, setup_with_kyc_bypass, TestContext};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, String,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: deposit `assets` for `user` and return the shares received.
// ─────────────────────────────────────────────────────────────────────────────
fn deposit(ctx: &crate::test_helpers::TestContext, user: &Address, assets: i128) -> i128 {
    mint_usdc(&ctx.env, &ctx.asset_id, user, assets);
    ctx.vault().deposit(user, &assets, user)
}

/// Lower the funding target to match current assets and activate the vault.
fn activate(ctx: &TestContext) {
    let current = ctx.vault().total_assets();
    if current < ctx.params.funding_target {
        ctx.vault().set_funding_target(&ctx.admin, &current);
    }
    ctx.vault().activate_vault(&ctx.admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Withdraw exact assets — verify shares burned and assets received
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_exact_assets() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let deposit_amount = normalize_amount(10.0, 6);
    let withdraw_amount = normalize_amount(4.0, 6);

    deposit(&ctx, &ctx.user.clone(), deposit_amount); // 10 USDC → 10 shares (1:1)
    activate(&ctx);

    let shares_before = v.balance(&ctx.user);
    let supply_before = v.total_supply();

    // Withdraw 4 USDC worth of shares.
    let shares_burned = v.withdraw(&ctx.user, &withdraw_amount, &ctx.user, &ctx.user);

    let shares_after = v.balance(&ctx.user);
    let supply_after = v.total_supply();

    assert_eq!(
        shares_burned, withdraw_amount,
        "should burn exactly the preview amount"
    );
    assert_eq!(
        shares_after,
        shares_before - shares_burned,
        "share balance decremented"
    );
    assert_eq!(
        supply_after,
        supply_before - shares_burned,
        "total supply decremented"
    );
    // User receives the withdrawn assets back.
    assert_eq!(
        ctx.asset().balance(&ctx.user),
        withdraw_amount,
        "user received withdrawn assets"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Redeem exact shares — verify correct assets returned
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_redeem_exact_shares() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let deposit_amount = normalize_amount(10.0, 6);
    let redeem_shares = normalize_amount(6.0, 6);
    let remaining_shares = normalize_amount(4.0, 6);

    deposit(&ctx, &ctx.user.clone(), deposit_amount); // 10 USDC → 10 shares
    activate(&ctx);

    let supply_before = v.total_supply();

    // Redeem 6 shares.
    let assets_returned = v.redeem(&ctx.user, &redeem_shares, &ctx.user, &ctx.user);

    assert_eq!(assets_returned, redeem_shares, "1:1 → 6 shares = 6 USDC");
    assert_eq!(v.balance(&ctx.user), remaining_shares, "4 shares remain");
    assert_eq!(
        v.total_supply(),
        supply_before - redeem_shares,
        "supply down by 6"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Withdraw via allowance — spender withdraws on owner's behalf
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_via_allowance() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let spender = Address::generate(&ctx.env);
    let deposit_amount = normalize_amount(10.0, 6);
    let approved_shares = normalize_amount(5.0, 6);
    let withdraw_amount = normalize_amount(3.0, 6);
    let remaining_allowance = normalize_amount(2.0, 6);
    let remaining_balance = normalize_amount(7.0, 6);

    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    // Approve spender for 5 shares worth of allowance.
    v.approve(&ctx.user, &spender, &approved_shares, &9999u32);
    assert_eq!(v.allowance(&ctx.user, &spender), approved_shares);

    // Spender withdraws 3 USDC on owner's behalf; assets go to spender.
    let shares_burned = v.withdraw(&spender, &withdraw_amount, &spender, &ctx.user);

    // At 1:1 the 3 USDC withdrawal cost 3 shares of allowance.
    assert_eq!(shares_burned, withdraw_amount);
    assert_eq!(
        v.allowance(&ctx.user, &spender),
        remaining_allowance,
        "allowance decremented by shares used"
    );
    assert_eq!(
        v.balance(&ctx.user),
        remaining_balance,
        "owner still has 7 shares"
    );
    assert_eq!(
        ctx.asset().balance(&spender),
        withdraw_amount,
        "spender received the assets"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Redeem via allowance — same pattern with redeem
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_redeem_via_allowance() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let spender = Address::generate(&ctx.env);
    let deposit_amount = normalize_amount(10.0, 6);
    let approved_shares = normalize_amount(4.0, 6);
    let remaining_balance = normalize_amount(6.0, 6);

    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    // Approve spender for 4 shares.
    v.approve(&ctx.user, &spender, &approved_shares, &9999u32);

    // Spender redeems 4 shares; assets flow to spender.
    let assets_returned = v.redeem(&spender, &approved_shares, &spender, &ctx.user);

    assert_eq!(assets_returned, approved_shares);
    assert_eq!(
        v.allowance(&ctx.user, &spender),
        0,
        "allowance fully consumed"
    );
    assert_eq!(
        v.balance(&ctx.user),
        remaining_balance,
        "owner has 6 shares left"
    );
    assert_eq!(ctx.asset().balance(&spender), approved_shares);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Error: insufficient allowance on withdraw
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_withdraw_insufficient_allowance_panics() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let spender = Address::generate(&ctx.env);

    deposit(&ctx, &ctx.user.clone(), 10_000_000);
    activate(&ctx);

    // Grant only 2 shares of allowance but try to withdraw 5 USDC (= 5 shares).
    v.approve(&ctx.user, &spender, &2_000_000i128, &9999u32);
    v.withdraw(&spender, &5_000_000i128, &spender, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Error: redeem more shares than the owner holds
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_redeem_insufficient_shares_panics() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    deposit(&ctx, &ctx.user.clone(), 5_000_000); // 5 shares
    activate(&ctx);

    // Try to redeem more shares than the user holds — must panic.
    v.redeem(&ctx.user, &10_000_000i128, &ctx.user, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Error: withdraw while vault is paused
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_withdraw_while_paused_panics() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    deposit(&ctx, &ctx.user.clone(), 5_000_000);
    activate(&ctx);

    v.pause(&ctx.admin, &String::from_str(&ctx.env, "emergency"));
    assert!(v.paused());

    v.withdraw(&ctx.user, &2_000_000i128, &ctx.user, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Edge case: withdraw entire balance — share balance reaches 0
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_entire_balance() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    deposit(&ctx, &ctx.user.clone(), 8_000_000); // 8 shares
    activate(&ctx);

    let shares = v.balance(&ctx.user);
    let assets = v.preview_redeem(&shares);

    v.withdraw(&ctx.user, &assets, &ctx.user, &ctx.user);

    assert_eq!(v.balance(&ctx.user), 0, "share balance drained to 0");
    assert_eq!(v.total_supply(), 0, "total supply is 0");
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Non-1:1 share price: distribute yield, verify preview and redeem output
//
// Mechanism: use distribute_yield to inject extra assets without creating new
// shares, so each existing share is worth more than 1 asset unit.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_redeem_at_non_unit_share_price() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let deposit_amount = normalize_amount(40.0, 6);
    let yield_amount = normalize_amount(20.0, 6);
    let expected_total_assets = normalize_amount(60.0, 6);

    // Deposit 40 USDC → 40 shares (1:1).
    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    let supply = v.total_supply(); // 40_000_000
    let assets_before = v.total_assets(); // 40_000_000

    // Simulate yield via distribute_yield (operator distributes 20 USDC).
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, yield_amount);
    v.distribute_yield(&ctx.admin, &yield_amount);

    let assets_after = v.total_assets(); // 60_000_000
    assert_eq!(assets_after, assets_before + yield_amount);

    // preview_redeem: 40 shares * 60 assets / 40 shares = 60 assets
    let expected_redeem = supply * assets_after / supply; // = 60_000_000
    assert_eq!(v.preview_redeem(&supply), expected_redeem);

    // Actually redeem all shares; user should receive 60 USDC.
    let received = v.redeem(&ctx.user, &supply, &ctx.user, &ctx.user);
    assert_eq!(
        received, expected_total_assets,
        "user receives principal + yield"
    );
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(ctx.asset().balance(&ctx.user), expected_total_assets);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Non-1:1: withdraw by asset amount, verify shares burned < assets
//     (because each share is worth more than 1 asset, fewer shares cover assets)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_at_non_unit_share_price() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let deposit_amount = normalize_amount(40.0, 6);
    let yield_amount = normalize_amount(40.0, 6);
    let withdraw_amount = normalize_amount(20.0, 6);
    let expected_shares = normalize_amount(10.0, 6);
    let remaining_shares = normalize_amount(30.0, 6);

    // 40 USDC → 40 shares.
    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    // Distribute 40 USDC yield → total_assets = 80 USDC, still 40 shares outstanding.
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, yield_amount);
    v.distribute_yield(&ctx.admin, &yield_amount);

    // preview_withdraw(20 USDC): shares = ceil(20 * 40 / 80) = 10
    let shares_needed = v.preview_withdraw(&withdraw_amount);
    assert_eq!(
        shares_needed, expected_shares,
        "20 USDC costs only 10 shares at 2:1"
    );

    let shares_burned = v.withdraw(&ctx.user, &withdraw_amount, &ctx.user, &ctx.user);
    assert_eq!(shares_burned, expected_shares);
    assert_eq!(v.balance(&ctx.user), remaining_shares, "30 shares remain");
    assert_eq!(
        ctx.asset().balance(&ctx.user),
        withdraw_amount,
        "received 20 USDC"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Error: withdraw zero assets must panic with ZeroAmount
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_withdraw_zero_assets_panics() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    deposit(&ctx, &ctx.user.clone(), 10_000_000);
    activate(&ctx);

    // Must panic with ZeroAmount — passing 0 assets.
    v.withdraw(&ctx.user, &0i128, &ctx.user, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Boundary: withdrawal right before maturity_date (#173)
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_withdraw_just_before_maturity() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let deposit_amount = normalize_amount(100.0, 6);
    let withdraw_amount = normalize_amount(50.0, 6);

    // Initial deposit and activation
    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    // Advance time to 1 second before maturity
    let maturity = v.maturity_date();
    ctx.env.ledger().with_mut(|li| li.timestamp = maturity - 1);
    assert_eq!(ctx.env.ledger().timestamp(), maturity - 1);

    // Vault should still be Active
    assert_eq!(v.vault_state(), crate::VaultState::Active);

    let shares_before = v.balance(&ctx.user);
    // Withdraw 50 USDC
    v.withdraw(&ctx.user, &withdraw_amount, &ctx.user, &ctx.user);

    // Verify results
    assert_eq!(v.balance(&ctx.user), shares_before - withdraw_amount);
    assert_eq!(ctx.asset().balance(&ctx.user), withdraw_amount);
    assert_eq!(v.vault_state(), crate::VaultState::Active);
}
