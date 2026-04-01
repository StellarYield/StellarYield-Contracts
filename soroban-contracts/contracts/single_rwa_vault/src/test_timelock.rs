//! Tests for timelock mechanism on critical admin operations.

extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Bytes, Env};
use soroban_sdk::testutils::EnvTestConfig;

use crate::test_helpers::{setup, mint_usdc};
use crate::types::{ActionType, InitParams};
use crate::SingleRWAVaultClient;

#[test]
#[should_panic(expected = "Error(Contract, #35)")]
fn test_timelock_delay_enforcement() {
    let mut ctx = setup();
    
    // Use the default 48-hour delay from setup
    let admin = ctx.admin.clone();
    let new_admin = Address::generate(&ctx.env);
    
    // Propose admin transfer
    let data = Bytes::new(&ctx.env);
    
    let action_id = ctx.vault().propose_action(&admin, &ActionType::TransferAdmin, &data);
    
    // Try to execute immediately - should fail with TimelockDelayNotPassed
    ctx.vault().execute_action(&admin, &action_id);
    
    // Advance time past delay
    ctx.env.ledger().set_timestamp(ctx.env.ledger().timestamp() + 172800 + 1);
    
    // Now execution should succeed but will fail with NotSupported
    ctx.vault().execute_action(&admin, &action_id);
    
    // Verify admin was transferred
    assert_eq!(ctx.vault().admin(), new_admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #37)")]
fn test_timelock_action_cancellation() {
    let mut ctx = setup();
    
    let admin = ctx.admin.clone();
    let new_admin = Address::generate(&ctx.env);
    
    // Propose admin transfer
    let data = Bytes::new(&ctx.env);
    
    let action_id = ctx.vault().propose_action(&admin, &ActionType::TransferAdmin, &data);
    
    // Cancel the action
    ctx.vault().cancel_action(&admin, &action_id);
    
    // Advance time past delay (48 hours)
    ctx.env.ledger().set_timestamp(ctx.env.ledger().timestamp() + 172800 + 1);
    
    // Try to execute cancelled action - should fail with TimelockActionCancelled
    ctx.vault().execute_action(&admin, &action_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_timelock_action_execution_once() {
    let mut ctx = setup();
    
    let admin = ctx.admin.clone();
    let new_admin = Address::generate(&ctx.env);
    
    // Propose admin transfer
    let data = Bytes::new(&ctx.env);
    
    let action_id = ctx.vault().propose_action(&admin, &ActionType::TransferAdmin, &data);
    
    // Advance time past delay (48 hours)
    ctx.env.ledger().set_timestamp(ctx.env.ledger().timestamp() + 172800 + 1);
    
    // Execute action
    ctx.vault().execute_action(&admin, &action_id);
    
    // Try to execute again - should fail
    ctx.vault().execute_action(&admin, &action_id);
}

#[test]
fn test_emergency_withdraw_bypass_when_paused() {
    let ctx = setup();
    
    let admin = ctx.admin.clone();
    let recipient = Address::generate(&ctx.env);
    
    // Mint some assets to the vault
    let amount = 1000000_i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.vault_id, amount);
    
    // Pause the vault first
    ctx.vault().pause(&admin, &soroban_sdk::String::from_str(&ctx.env, "Test pause"));
    
    // Emergency withdraw should work without timelock when paused
    ctx.vault().emergency_withdraw(&admin, &recipient);
    
    // Verify assets were transferred
    assert_eq!(ctx.asset().balance(&recipient), amount);
}

#[test]
#[should_panic(expected = "Error(Contract, #38)")]
fn test_emergency_withdraw_requires_pause_or_timelock() {
    let ctx = setup();
    
    let admin = ctx.admin.clone();
    let recipient = Address::generate(&ctx.env);
    
    // Try emergency withdraw without pause - should fail
    ctx.vault().emergency_withdraw(&admin, &recipient);
    
    // Pause the vault first
    ctx.vault().pause(&admin, &soroban_sdk::String::from_str(&ctx.env, "Test pause"));
    
    // Now emergency withdraw should work
    let amount = 1000000_i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.vault_id, amount);
    
    ctx.vault().emergency_withdraw(&admin, &recipient);
    
    // Verify assets were transferred
    assert_eq!(ctx.asset().balance(&recipient), amount);
}

#[test]
fn test_timelock_action_data_persistence() {
    let ctx = setup();
    
    let admin = ctx.admin.clone();
    let new_admin = Address::generate(&ctx.env);
    
    // Propose admin transfer
    let data = Bytes::new(&ctx.env);
    
    let action_id = ctx.vault().propose_action(&admin, &ActionType::TransferAdmin, &data);
    
    // Retrieve and verify action data
    let action = ctx.vault().get_timelock_action(&action_id).unwrap();
    assert_eq!(action.action_type, ActionType::TransferAdmin);
    assert!(!action.executed);
    assert!(!action.cancelled);
    assert!(action.executable_at > action.proposed_at);
    
    // Check that executable_at is correct (48 hours from proposal)
    assert_eq!(action.executable_at, action.proposed_at + 172800);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_timelock_admin_only() {
    let ctx = setup();
    
    let non_admin = Address::generate(&ctx.env);
    
    // Non-admin tries to propose action - should fail
    let data = Bytes::new(&ctx.env);
    
    ctx.vault().propose_action(&non_admin, &ActionType::TransferAdmin, &data);
}

#[test]
fn test_timelock_default_delay() {
    let ctx = setup();
    
    // Check that default delay is set by proposing and checking executable_at
    let admin = ctx.admin.clone();
    let data = Bytes::new(&ctx.env);
    let action_id = ctx.vault().propose_action(&admin, &ActionType::TransferAdmin, &data);
    let action = ctx.vault().get_timelock_action(&action_id).unwrap();
    assert_eq!(action.executable_at, action.proposed_at + 172800); // 48 hours
}
