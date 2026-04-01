//! Tests for investor participant counter and maximum investor cap functionality.
//!
//! Covers:
//! - Investor count tracking on deposit/mint
//! - Investor count decrement on withdraw/redeem
//! - Max investor cap enforcement
//! - Admin functions for setting max investors
//! - Edge cases: re-entry after exit, transfer impact

extern crate std;

use crate::test_helpers::{advance_time, mint_usdc, setup_with_kyc_bypass};
use soroban_sdk::{testutils::Address as _, Address};

// ─────────────────────────────────────────────────────────────────────────────
// Basic investor count tracking
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_investor_count_increments_on_first_deposit() {
    let ctx = setup_with_kyc_bypass();
    
    // Initially no investors
    assert_eq!(ctx.vault().investor_count(), 0);
    
    // First user deposits
    let user1 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user1, 1_000_000);
    ctx.vault().deposit(&user1, &100_000, &user1);
    
    // Should have 1 investor
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Second user deposits
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user2, 1_000_000);
    ctx.vault().deposit(&user2, &100_000, &user2);
    
    // Should have 2 investors
    assert_eq!(ctx.vault().investor_count(), 2);
}

#[test]
fn test_investor_count_increments_on_first_mint() {
    let ctx = setup_with_kyc_bypass();
    
    // Initially no investors
    assert_eq!(ctx.vault().investor_count(), 0);
    
    // First user mints
    let user1 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user1, 1_000_000);
    ctx.vault().mint(&user1, &100_000, &user1);
    
    // Should have 1 investor
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Second user mints
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user2, 1_000_000);
    ctx.vault().mint(&user2, &100_000, &user2);
    
    // Should have 2 investors
    assert_eq!(ctx.vault().investor_count(), 2);
}

#[test]
fn test_investor_count_not_incremented_on_additional_deposits() {
    let ctx = setup_with_kyc_bypass();
    
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user, 1_000_000);
    
    // First deposit increments count
    ctx.vault().deposit(&user, &100_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Additional deposits don't increment count
    ctx.vault().deposit(&user, &50_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    ctx.vault().deposit(&user, &25_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Investor count decrement on exit
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_investor_count_decrements_on_full_withdraw() {
    let ctx = setup_with_kyc_bypass();
    
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user, 1_000_000);
    
    // Deposit creates investor
    ctx.vault().deposit(&user, &100_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Activate vault to enable withdrawals
    advance_time(&ctx, 1000);
    ctx.vault().activate_vault(&ctx.operator);
    
    // Full withdraw removes investor
    let shares = ctx.vault().max_redeem(&user);
    ctx.vault().withdraw(&user, &100_000, &user, &user);
    assert_eq!(ctx.vault().investor_count(), 0);
}

#[test]
fn test_investor_count_decrements_on_full_redeem() {
    let ctx = setup_with_kyc_bypass();
    
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user, 1_000_000);
    
    // Deposit creates investor
    ctx.vault().deposit(&user, &100_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Activate vault to enable redemptions
    advance_time(&ctx, 1000);
    ctx.vault().activate_vault(&ctx.operator);
    
    // Full redeem removes investor
    let shares = ctx.vault().max_redeem(&user);
    ctx.vault().redeem(&user, &shares, &user, &user);
    assert_eq!(ctx.vault().investor_count(), 0);
}

#[test]
fn test_investor_count_not_decremented_on_partial_withdraw() {
    let ctx = setup_with_kyc_bypass();
    
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user, 1_000_000);
    
    // Deposit creates investor
    ctx.vault().deposit(&user, &100_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Activate vault to enable withdrawals
    advance_time(&ctx, 1000);
    ctx.vault().activate_vault(&ctx.operator);
    
    // Partial withdraw doesn't remove investor
    ctx.vault().withdraw(&user, &50_000, &user, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Still has shares, so still counted as investor
    assert!(ctx.vault().max_redeem(&user) > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Max investor cap enforcement
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #36)")]
fn test_max_investors_cap_enforced_on_deposit() {
    let ctx = setup_with_kyc_bypass();
    
    // Set max investors to 2
    ctx.vault().set_max_investors(&ctx.admin, &2);
    
    // First investor
    let user1 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user1, 1_000_000);
    ctx.vault().deposit(&user1, &100_000, &user1);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Second investor
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user2, 1_000_000);
    ctx.vault().deposit(&user2, &100_000, &user2);
    assert_eq!(ctx.vault().investor_count(), 2);
    
    // Third investor should panic
    let user3 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user3, 1_000_000);
    ctx.vault().deposit(&user3, &100_000, &user3);
}

#[test]
#[should_panic(expected = "Error(Contract, #36)")]
fn test_max_investors_cap_enforced_on_mint() {
    let ctx = setup_with_kyc_bypass();
    
    // Set max investors to 2
    ctx.vault().set_max_investors(&ctx.admin, &2);
    
    // First investor
    let user1 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user1, 1_000_000);
    ctx.vault().mint(&user1, &100_000, &user1);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Second investor
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user2, 1_000_000);
    ctx.vault().mint(&user2, &100_000, &user2);
    assert_eq!(ctx.vault().investor_count(), 2);
    
    // Third investor should panic
    let user3 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user3, 1_000_000);
    ctx.vault().mint(&user3, &100_000, &user3);
}

#[test]
fn test_max_investors_zero_allows_unlimited() {
    let ctx = setup_with_kyc_bypass();
    
    // Set max investors to 0 (unlimited)
    ctx.vault().set_max_investors(&ctx.admin, &0);
    
    // Should be able to add many investors
    for i in 0..5 {
        let user = Address::generate(&ctx.env);
        mint_usdc(&ctx, &user, 1_000_000);
        ctx.vault().deposit(&user, &100_000, &user);
        assert_eq!(ctx.vault().investor_count(), i + 1);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-entry after exit
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_re_entry_after_exit_increments_count_again() {
    let ctx = setup_with_kyc_bypass();
    
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user, 1_000_000);
    
    // First deposit creates investor
    ctx.vault().deposit(&user, &100_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Activate vault and fully exit
    advance_time(&ctx, 1000);
    ctx.vault().activate_vault(&ctx.operator);
    let shares = ctx.vault().max_redeem(&user);
    ctx.vault().redeem(&user, &shares, &user, &user);
    assert_eq!(ctx.vault().investor_count(), 0);
    
    // Re-entry should increment count again
    mint_usdc(&ctx, &user, 1_000_000);
    ctx.vault().deposit(&user, &100_000, &user);
    assert_eq!(ctx.vault().investor_count(), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin functions
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_max_investors_admin_only() {
    let ctx = setup_with_kyc_bypass();
    
    // Admin can set max investors
    ctx.vault().set_max_investors(&ctx.admin, &5);
    assert_eq!(ctx.vault().max_investors(), 5);
    
    // Non-admin cannot set max investors
    let random_user = Address::generate(&ctx.env);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx.vault().set_max_investors(&random_user, &10);
    }));
    assert!(result.is_err());
}

#[test]
fn test_set_max_investors_updates_value() {
    let ctx = setup_with_kyc_bypass();
    
    // Initial value
    assert_eq!(ctx.vault().max_investors(), 100); // Default from setup
    
    // Update to different values
    ctx.vault().set_max_investors(&ctx.admin, &0);
    assert_eq!(ctx.vault().max_investors(), 0);
    
    ctx.vault().set_max_investors(&ctx.admin, &50);
    assert_eq!(ctx.vault().max_investors(), 50);
    
    ctx.vault().set_max_investors(&ctx.admin, &1000);
    assert_eq!(ctx.vault().max_investors(), 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer impact on investor count
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_transfer_shares_to_new_user_does_not_change_count() {
    let ctx = setup_with_kyc_bypass();
    
    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user1, 1_000_000);
    
    // First user deposits
    ctx.vault().deposit(&user1, &100_000, &user1);
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // Transfer all shares to new user
    let shares = ctx.vault().max_redeem(&user1);
    ctx.vault().transfer(&user1, &user2, &shares);
    
    // Investor count should still be 1 (user1 now has 0, user2 has shares)
    assert_eq!(ctx.vault().investor_count(), 1);
    
    // User1 should no longer be counted as investor (balance = 0)
    // User2 should be counted as investor (balance > 0)
    assert_eq!(ctx.vault().max_redeem(&user1), 0);
    assert!(ctx.vault().max_redeem(&user2) > 0);
}

#[test]
fn test_transfer_shares_between_existing_investors_no_count_change() {
    let ctx = setup_with_kyc_bypass();
    
    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);
    mint_usdc(&ctx, &user1, 1_000_000);
    mint_usdc(&ctx, &user2, 1_000_000);
    
    // Both users deposit
    ctx.vault().deposit(&user1, &100_000, &user1);
    ctx.vault().deposit(&user2, &100_000, &user2);
    assert_eq!(ctx.vault().investor_count(), 2);
    
    // Transfer some shares from user1 to user2
    ctx.vault().transfer(&user1, &user2, &50_000);
    
    // Count should still be 2 (both still have shares)
    assert_eq!(ctx.vault().investor_count(), 2);
    assert!(ctx.vault().max_redeem(&user1) > 0);
    assert!(ctx.vault().max_redeem(&user2) > 0);
}
