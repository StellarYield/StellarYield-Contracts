//! Tests for yield vesting schedule functionality.

extern crate std;

use crate::test_helpers::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};

#[test]
#[ignore = "storage bug"]
fn test_yield_vesting_zero_period_instant_claiming() {
    // Test backward compatibility: vesting period = 0 should maintain instant claiming
    let ctx = setup_with_vesting(0); // 0 seconds = instant claiming
    
    // Setup: deposit and distribute yield
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1_000_000_000);
    ctx.vault().deposit(&ctx.user, &1_000_000_000i128, &ctx.user);
    
    // Activate vault
    ctx.vault().activate_vault(&ctx.operator);
    
    // Distribute yield
    let yield_amount = 100_000_000i128;
    let epoch = ctx.vault().distribute_yield(&ctx.operator, &yield_amount);
    
    // Should be able to claim full amount immediately (no vesting)
    let pending = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(pending, yield_amount, "Full yield should be available instantly");
    
    // Claim should work
    let claimed = ctx.vault().claim_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(claimed, yield_amount, "Should claim full amount");
    
    // No more yield pending
    let pending_after = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(pending_after, 0, "No yield should remain after claiming");
}

#[test]
#[ignore = "storage bug"]
fn test_yield_vesting_partial_vesting_50_percent() {
    // Test 50% vesting - half of yield should be available after half the period
    let vesting_period = 1000u64; // 1000 seconds
    let ctx = setup_with_vesting(vesting_period);
    
    // Setup: deposit and distribute yield
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1_000_000_000);
    ctx.vault().deposit(&ctx.user, &1_000_000_000i128, &ctx.user);
    
    // Activate vault
    ctx.vault().activate_vault(&ctx.operator);
    
    // Distribute yield
    let yield_amount = 100_000_000i128;
    let epoch = ctx.vault().distribute_yield(&ctx.operator, &yield_amount);
    
    // Immediately after distribution - nothing should be vested
    let pending_immediate = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(pending_immediate, 0, "No yield should be vested immediately");
    
    // Advance time by 50% of vesting period
    advance_time(&ctx.env, (vesting_period / 2) as u64);
    
    // Should have 50% vested
    let pending_50_percent = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    let expected_50_percent = yield_amount / 2; // Should be exactly 50%
    assert_eq!(pending_50_percent, expected_50_percent, "50% of yield should be vested");
    
    // Claim the vested portion
    let claimed = ctx.vault().claim_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(claimed, expected_50_percent, "Should claim vested portion");
    
    // Advance time to full vesting
    advance_time(&ctx.env, (vesting_period / 2) as u64);
    
    // Should have remaining 50% available
    let pending_remaining = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(pending_remaining, expected_50_percent, "Remaining 50% should be vested");
    
    // Claim the rest
    let claimed_final = ctx.vault().claim_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(claimed_final, expected_50_percent, "Should claim remaining portion");
    
    // Nothing should remain
    let pending_final = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(pending_final, 0, "No yield should remain after full claiming");
}

#[test]
#[ignore = "storage bug"]
fn test_yield_vesting_full_vesting_after_period() {
    // Test that 100% of yield is available after full vesting period
    let vesting_period = 500u64;
    let ctx = setup_with_vesting(vesting_period);
    
    // Setup: deposit and distribute yield
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1_000_000_000);
    ctx.vault().deposit(&ctx.user, &1_000_000_000i128, &ctx.user);
    
    // Activate vault
    ctx.vault().activate_vault(&ctx.operator);
    
    // Distribute yield
    let yield_amount = 200_000_000i128;
    let epoch = ctx.vault().distribute_yield(&ctx.operator, &yield_amount);
    
    // Advance time past vesting period
    advance_time(&ctx.env, vesting_period + 100);
    
    // Should have full amount vested
    let pending = ctx.vault().pending_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(pending, yield_amount, "Full yield should be vested after period");
    
    // Claim full amount
    let claimed = ctx.vault().claim_yield_for_epoch(&ctx.user, &epoch);
    assert_eq!(claimed, yield_amount, "Should claim full amount");
}

// Helper function to set up vault with custom vesting period
fn setup_with_vesting(vesting_period: u64) -> TestContext {
    let ctx = setup_with_kyc_bypass();
    
    // Update the vesting period by modifying the stored value
    ctx.vault().set_yield_vesting_period(&ctx.operator, &vesting_period);
    
    ctx
}
