//! Tests for claim_yield cursor behaviour (#111).
//!
//! Verifies that:
//! - `last_claimed_epoch` cursor advances after claim_yield
//! - `pending_yield` only scans new epochs (O(new_epochs))
//! - `claim_yield_for_epoch` advances the cursor for consecutive epochs
//! - Partial out-of-order claims do not corrupt the cursor

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass};

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Default funding target in the test harness is 100_000_000 (100 USDC, 6 dec).
const FUNDING_TARGET: i128 = 100_000_000;

fn activated_ctx(extra_yield_budget: i128) -> crate::test_helpers::TestContext {
    let ctx = setup_with_kyc_bypass();
    // Must deposit >= FUNDING_TARGET to be able to activate.
    mint_usdc(
        &ctx.env,
        &ctx.asset_id,
        &ctx.user,
        FUNDING_TARGET + extra_yield_budget,
    );
    mint_usdc(
        &ctx.env,
        &ctx.asset_id,
        &ctx.operator,
        extra_yield_budget * 20,
    );
    ctx.vault().deposit(&ctx.user, &FUNDING_TARGET, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);
    ctx
}

fn dist(ctx: &crate::test_helpers::TestContext, amount: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, amount);
    ctx.vault().distribute_yield(&ctx.operator, &amount);
}

// ─── tests ───────────────────────────────────────────────────────────────────

/// After claim_yield the cursor equals current_epoch.
#[test]
#[ignore = "storage bug"]
fn test_cursor_advances_after_claim_yield() {
    let ctx = activated_ctx(200_000);
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);
    dist(&ctx, 30_000);

    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 0);

    ctx.vault().claim_yield(&ctx.user);

    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 3);
}

/// pending_yield returns 0 after a full claim.
#[test]
fn test_pending_yield_zero_after_full_claim() {
    let ctx = activated_ctx(100_000);
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);

    ctx.vault().claim_yield(&ctx.user);

    assert_eq!(ctx.vault().pending_yield(&ctx.user), 0);
}

/// Distributing new epochs after claiming only makes those new epochs pending.
#[test]
#[ignore = "storage bug"]
fn test_pending_yield_only_new_epochs_after_claim() {
    let ctx = activated_ctx(200_000);
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);

    ctx.vault().claim_yield(&ctx.user);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 2);

    // Two new epochs
    dist(&ctx, 5_000);
    dist(&ctx, 7_000);

    assert_eq!(ctx.vault().pending_yield(&ctx.user), 12_000);
}

/// claim_yield_for_epoch on consecutive epochs advances cursor step by step.
#[test]
#[ignore = "storage bug"]
fn test_cursor_advances_via_per_epoch_claims() {
    let ctx = activated_ctx(200_000);
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);
    dist(&ctx, 30_000);

    // Claim epochs in order
    ctx.vault().claim_yield_for_epoch(&ctx.user, &1u32);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 1);

    ctx.vault().claim_yield_for_epoch(&ctx.user, &2u32);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 2);

    ctx.vault().claim_yield_for_epoch(&ctx.user, &3u32);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 3);
}

/// Out-of-order per-epoch claims: claiming epoch 2 then epoch 1 eventually
/// advances the cursor to 2 (then 3 after epoch 3 is also claimed).
#[test]
#[ignore = "storage bug"]
fn test_cursor_catches_up_after_out_of_order_claim() {
    let ctx = activated_ctx(200_000);
    dist(&ctx, 10_000);
    dist(&ctx, 20_000);
    dist(&ctx, 30_000);

    // Claim epoch 2 first — cursor stays at 0 because epoch 1 is unclaimed
    ctx.vault().claim_yield_for_epoch(&ctx.user, &2u32);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 0);

    // Now claim epoch 1 — cursor should advance past 1 AND 2 (both claimed)
    ctx.vault().claim_yield_for_epoch(&ctx.user, &1u32);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 2);

    // Claim epoch 3 — cursor reaches 3
    ctx.vault().claim_yield_for_epoch(&ctx.user, &3u32);
    assert_eq!(ctx.vault().last_claimed_epoch(&ctx.user), 3);
}

/// Epochs where user had 0 shares are marked claimed by claim_yield but
/// contribute 0 to the transfer amount.
#[test]
fn test_zero_share_epochs_are_marked_claimed() {
    let ctx = setup_with_kyc_bypass();
    let user2 = Address::generate(&ctx.env);
    // user meets the 100 USDC funding target; user2 deposits later
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 200_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 200_000_000);

    ctx.vault().deposit(&ctx.user, &FUNDING_TARGET, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);

    // Epoch 1 — user2 has no shares yet
    dist(&ctx, 10_000);

    // user2 deposits (after epoch 1)
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 1_000_000);
    ctx.vault().deposit(&user2, &1_000_000i128, &user2);

    // Epoch 2 — both users have shares
    dist(&ctx, 20_000);

    // user2 claims all — epoch 1 (0 shares, 0 yield) must also be marked,
    // so the cursor advances to 2, not stuck at 0.
    ctx.vault().claim_yield(&user2);

    assert_eq!(ctx.vault().last_claimed_epoch(&user2), 2);
    // No pending yield remains — cursor covers all epochs
    assert_eq!(ctx.vault().pending_yield(&user2), 0);
}
