//! Tests for insufficient vault balance scenarios (issue #104).

extern crate std;

use crate::test_helpers::{setup_with_kyc_bypass, mint_usdc, advance_time};
use soroban_sdk::{testutils::Ledger, Address, Env, Error as SorobanError};
use stellar_yield_contracts::SingleRWAVault;

#[test]
fn test_vault_balance_check_withdraw_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // User deposits some assets
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000i128);
    vault.deposit(&ctx.user, &100_000i128, &ctx.user);
    
    // Drain vault balance directly from token contract (simulating external drain)
    let vault_balance = asset.balance(&vault.address);
    asset.transfer(&vault.address, &ctx.admin, &vault_balance);
    
    // Now vault has 0 balance but user has shares
    assert_eq!(asset.balance(&vault.address), 0);
    assert_eq!(vault.balance(&ctx.user), 100_000i128);
    
    // Attempt to withdraw - should fail with InsufficientVaultBalance
    let result = std::panic::catch_unwind(|| {
        vault.withdraw(&ctx.user, &50_000i128, &ctx.user, &ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientVaultBalance"));
    
    // Verify state is unchanged - user still has shares
    assert_eq!(vault.balance(&ctx.user), 100_000i128);
    assert_eq!(asset.balance(&ctx.user), 0);
}

#[test]
fn test_vault_balance_check_redeem_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // User deposits some assets
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000i128);
    vault.deposit(&ctx.user, &100_000i128, &ctx.user);
    
    // Drain vault balance directly from token contract
    let vault_balance = asset.balance(&vault.address);
    asset.transfer(&vault.address, &ctx.admin, &vault_balance);
    
    // Attempt to redeem - should fail with InsufficientVaultBalance
    let result = std::panic::catch_unwind(|| {
        vault.redeem(&ctx.user, &50_000i128, &ctx.user, &ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientVaultBalance"));
    
    // Verify state is unchanged
    assert_eq!(vault.balance(&ctx.user), 100_000i128);
    assert_eq!(asset.balance(&ctx.user), 0);
}

#[test]
fn test_vault_balance_check_claim_yield_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // User deposits some assets
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000i128);
    vault.deposit(&ctx.user, &100_000i128, &ctx.user);
    
    // Distribute yield
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 10_000i128);
    vault.distribute_yield(&ctx.operator, &10_000i128);
    
    // Drain vault balance directly from token contract (except for user's principal)
    let vault_balance = asset.balance(&vault.address);
    let user_principal = 100_000i128; // user's deposited amount
    let drain_amount = vault_balance - user_principal;
    if drain_amount > 0 {
        asset.transfer(&vault.address, &ctx.admin, &drain_amount);
    }
    
    // User should have pending yield but vault lacks sufficient balance
    let pending = vault.pending_yield(ctx.user.clone());
    assert!(pending > 0);
    
    // Attempt to claim yield - should fail with InsufficientVaultBalance
    let result = std::panic::catch_unwind(|| {
        vault.claim_yield(&ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientVaultBalance"));
    
    // Verify claim flags are not set (transaction rolled back)
    let last_claimed = vault.last_claimed_epoch(ctx.user);
    assert_eq!(last_claimed, 0); // Still 0, not updated
}

#[test]
fn test_vault_balance_check_redeem_at_maturity_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate and mature vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // Add some yield
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 50_000i128);
    vault.distribute_yield(&ctx.admin, &50_000i128);
    
    // Mature the vault
    advance_time(&ctx.env, 1_000_000);
    vault.mature_vault(&ctx.admin);
    
    // User deposits
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000i128);
    vault.deposit(&ctx.user, &100_000i128, &ctx.user);
    
    // Drain vault balance
    let vault_balance = asset.balance(&vault.address);
    asset.transfer(&vault.address, &ctx.admin, &vault_balance);
    
    // Attempt redeem_at_maturity - should fail with InsufficientVaultBalance
    let result = std::panic::catch_unwind(|| {
        vault.redeem_at_maturity(&ctx.user, &50_000i128, &ctx.user, &ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientVaultBalance"));
    
    // Verify state is unchanged
    assert_eq!(vault.balance(&ctx.user), 100_000i128);
    assert_eq!(asset.balance(&ctx.user), 0);
}

#[test]
fn test_vault_balance_check_emergency_claim_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // User deposits
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000i128);
    vault.deposit(&ctx.user, &100_000i128, &ctx.user);
    
    // Enable emergency mode
    vault.enable_emergency_mode(&ctx.admin);
    
    // Drain some but not all vault balance
    let vault_balance = asset.balance(&vault.address);
    let drain_amount = vault_balance / 2;
    asset.transfer(&vault.address, &ctx.admin, &drain_amount);
    
    // User should have some claim amount
    let pending = vault.pending_emergency_claim(ctx.user);
    assert!(pending > 0);
    
    // But vault has insufficient balance for all users
    let remaining_balance = asset.balance(&vault.address);
    assert!(remaining_balance < pending);
    
    // Attempt emergency claim - should fail with InsufficientVaultBalance
    let result = std::panic::catch_unwind(|| {
        vault.emergency_claim(&ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientVaultBalance"));
    
    // Verify claim flag is not set
    assert!(!vault.has_claimed_emergency(ctx.user));
    assert_eq!(vault.balance(&ctx.user), 100_000i128);
}

#[test]
fn test_user_balance_check_deposit_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // User has 0 balance but tries to deposit
    assert_eq!(asset.balance(&ctx.user), 0);
    
    // Attempt to deposit - should fail with InsufficientBalance (not generic token error)
    let result = std::panic::catch_unwind(|| {
        vault.deposit(&ctx.user, &100_000i128, &ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientBalance"));
    
    // Verify state is unchanged - no shares minted
    assert_eq!(vault.balance(&ctx.user), 0);
    assert_eq!(asset.balance(&vault.address), 1_000_000i128); // Only admin's deposit
}

#[test]
fn test_user_balance_check_mint_insufficient_balance() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Activate vault
    advance_time(&ctx.env, 1_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &1_000_000i128, &ctx.admin);
    vault.activate_vault(&ctx.admin);
    
    // User has 0 balance but tries to mint
    assert_eq!(asset.balance(&ctx.user), 0);
    
    // Attempt to mint - should fail with InsufficientBalance
    let result = std::panic::catch_unwind(|| {
        vault.mint(&ctx.user, &100_000i128, &ctx.user);
    });
    
    assert!(result.is_err());
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(err_str.contains("InsufficientBalance"));
    
    // Verify state is unchanged
    assert_eq!(vault.balance(&ctx.user), 0);
    assert_eq!(asset.balance(&vault.address), 1_000_000i128);
}

#[test]
fn test_vault_asset_balance_view_function() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();
    
    // Initially vault should have 0 balance
    assert_eq!(vault.vault_asset_balance(), 0);
    
    // Deposit some assets
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, 1_000_000i128);
    vault.deposit(&ctx.admin, &500_000i128, &ctx.admin);
    
    // Vault balance should reflect deposited assets
    assert_eq!(vault.vault_asset_balance(), 500_000i128);
    
    // Add more deposits
    vault.deposit(&ctx.admin, &300_000i128, &ctx.admin);
    assert_eq!(vault.vault_asset_balance(), 800_000i128);
    
    // Verify it matches direct token balance check
    assert_eq!(vault.vault_asset_balance(), asset.balance(&vault.address));
}
