//! Unit tests for withdraw and redeem operations on SingleRWAVault.
//!
//! Covers:
//!  - Happy paths: withdraw by exact assets, redeem by exact shares
//!  - Allowance paths: a spender acting on an owner's behalf
//!  - Error paths: insufficient allowance, insufficient shares, vault paused
//!  - Edge cases: drain entire balance, non-1:1 share price validation

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass, TestContext};
use soroban_sdk::{testutils::Address as _, Address, String};

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

    deposit(&ctx, &ctx.user.clone(), 10_000_000); // 10 USDC → 10 shares (1:1)
    activate(&ctx);

    let shares_before = v.balance(&ctx.user);
    let supply_before = v.total_supply();

    // Withdraw 4 USDC worth of shares.
    let shares_burned = v.withdraw(&ctx.user, &4_000_000i128, &ctx.user, &ctx.user);

    let shares_after = v.balance(&ctx.user);
    let supply_after = v.total_supply();

    assert_eq!(
        shares_burned, 4_000_000,
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
        4_000_000,
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

    deposit(&ctx, &ctx.user.clone(), 10_000_000); // 10 USDC → 10 shares
    activate(&ctx);

    let supply_before = v.total_supply();

    // Redeem 6 shares.
    let assets_returned = v.redeem(&ctx.user, &6_000_000i128, &ctx.user, &ctx.user);

    assert_eq!(assets_returned, 6_000_000, "1:1 → 6 shares = 6 USDC");
    assert_eq!(v.balance(&ctx.user), 4_000_000, "4 shares remain");
    assert_eq!(
        v.total_supply(),
        supply_before - 6_000_000,
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

    deposit(&ctx, &ctx.user.clone(), 10_000_000);
    activate(&ctx);

    // Approve spender for 5 shares worth of allowance.
    v.approve(&ctx.user, &spender, &5_000_000i128, &9999u32);
    assert_eq!(v.allowance(&ctx.user, &spender), 5_000_000);

    // Spender withdraws 3 USDC on owner's behalf; assets go to spender.
    let shares_burned = v.withdraw(&spender, &3_000_000i128, &spender, &ctx.user);

    // At 1:1 the 3 USDC withdrawal cost 3 shares of allowance.
    assert_eq!(shares_burned, 3_000_000);
    assert_eq!(
        v.allowance(&ctx.user, &spender),
        2_000_000,
        "allowance decremented by shares used"
    );
    assert_eq!(v.balance(&ctx.user), 7_000_000, "owner still has 7 shares");
    assert_eq!(
        ctx.asset().balance(&spender),
        3_000_000,
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

    deposit(&ctx, &ctx.user.clone(), 10_000_000);
    activate(&ctx);

    // Approve spender for 4 shares.
    v.approve(&ctx.user, &spender, &4_000_000i128, &9999u32);

    // Spender redeems 4 shares; assets flow to spender.
    let assets_returned = v.redeem(&spender, &4_000_000i128, &spender, &ctx.user);

    assert_eq!(assets_returned, 4_000_000);
    assert_eq!(
        v.allowance(&ctx.user, &spender),
        0,
        "allowance fully consumed"
    );
    assert_eq!(v.balance(&ctx.user), 6_000_000, "owner has 6 shares left");
    assert_eq!(ctx.asset().balance(&spender), 4_000_000);
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

    deposit(&ctx, &ctx.user.clone(), 5_000_000); // 5 shares
    activate(&ctx);

    // Try to redeem 10 shares — owner only has 5.
    ctx.vault()
        .redeem(&ctx.user, &10_000_000i128, &ctx.user, &ctx.user);
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
// 9. Non-1:1 share price: inject yield, verify preview and redeem output
//
// Mechanism: directly mint extra tokens to the vault contract address.
// This increases `total_assets` (vault token balance) without creating new
// shares, so each existing share is worth more than 1 asset unit.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_redeem_at_non_unit_share_price() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    // Deposit 40 USDC → 40 shares (1:1).
    deposit(&ctx, &ctx.user.clone(), 40_000_000);
    activate(&ctx);

    let supply = v.total_supply(); // 40_000_000
    let assets_before = v.total_assets(); // 40_000_000

    // Simulate yield: donate 20 USDC directly to the vault (no new shares).
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.vault_id, 20_000_000);

    let assets_after = v.total_assets(); // 60_000_000
    assert_eq!(assets_after, assets_before + 20_000_000);

    // preview_redeem: 40 shares * 60 assets / 40 shares = 60 assets
    let expected_redeem = supply * assets_after / supply; // = 60_000_000
    assert_eq!(v.preview_redeem(&supply), expected_redeem);

    // Actually redeem all shares; user should receive 60 USDC.
    let received = v.redeem(&ctx.user, &supply, &ctx.user, &ctx.user);
    assert_eq!(received, 60_000_000, "user receives principal + yield");
    assert_eq!(v.balance(&ctx.user), 0);
    assert_eq!(ctx.asset().balance(&ctx.user), 60_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Non-1:1: withdraw by asset amount, verify shares burned > assets
//     (because each share is worth more than 1 asset, fewer shares cover assets)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_at_non_unit_share_price() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    // 40 USDC → 40 shares.
    deposit(&ctx, &ctx.user.clone(), 40_000_000);
    activate(&ctx);

    // Vault now holds 80 USDC total (2× the deposited amount), still 40 shares outstanding.
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.vault_id, 40_000_000);

    // preview_withdraw(20 USDC): shares = ceil(20 * 40 / 80) = 10
    let shares_needed = v.preview_withdraw(&20_000_000i128);
    assert_eq!(
        shares_needed, 10_000_000,
        "20 USDC costs only 10 shares at 2:1"
    );

    let shares_burned = v.withdraw(&ctx.user, &20_000_000i128, &ctx.user, &ctx.user);
    assert_eq!(shares_burned, 10_000_000);
    assert_eq!(v.balance(&ctx.user), 30_000_000, "30 shares remain");
    assert_eq!(
        ctx.asset().balance(&ctx.user),
        20_000_000,
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

    deposit(&ctx, &ctx.user.clone(), 10_000_000);
    activate(&ctx);

    // Must panic — zero assets
    ctx.vault()
        .withdraw(&ctx.user, &0i128, &ctx.user, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Error: redeem zero shares must panic with ZeroAmount
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_redeem_zero_shares_panics() {
    let ctx = setup_with_kyc_bypass();

    deposit(&ctx, &ctx.user.clone(), 10_000_000);
    activate(&ctx);

    // Must panic — zero shares
    ctx.vault().redeem(&ctx.user, &0i128, &ctx.user, &ctx.user);
}
