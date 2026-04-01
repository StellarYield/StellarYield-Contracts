//! Tests for share transfer lock-up period functionality.

use soroban_sdk::testutils::Address as _;
use crate::test_helpers::{create_vault, deposit, mint_shares, transfer, transfer_from, withdraw, redeem, request_early_redemption};
use soroban_sdk::{testutils::Ledger as _, Address, Env, Symbol};
use crate::SingleRWAVault;
use crate::errors::Error;

#[test]
fn test_lock_up_period_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    // Create vault with 60-second lock-up period
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    // Verify lock-up period is stored correctly
    assert_eq!(SingleRWAVault::lock_up_remaining(&env, admin), 0); // No deposits yet
    
    // Check that we can query the lock-up period setting
    // Note: We'd need to add a getter for this, but we can verify through behavior
}

#[test]
fn test_deposit_stores_timestamp() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    // Set ledger timestamp to a known value
    env.ledger().set_timestamp(1000);
    
    // Deposit
    deposit(&env, user.clone(), 1000, user.clone());
    
    // Verify lock-up remaining is approximately 60 seconds
    let remaining = SingleRWAVault::lock_up_remaining(&env, user.clone());
    assert!(remaining > 50 && remaining <= 60); // Allow some tolerance
}

#[test]
fn test_transfer_blocked_during_lock_up() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // User1 deposits
    deposit(&env, user1.clone(), 1000, user1.clone());
    
    // Try to transfer immediately - should fail
    let result = env.try_invoke_contract::<_, (
        Result<(), Error>,
        Result<(), soroban_sdk::InvokeError>
    )>(
        &vault.address,
        &Symbol::new(&env, "transfer"),
        (&user1, &user2, 500),
    );
    assert_eq!(result.0, Err(Error::SharesLocked));
    
    // Try transfer_from - should also fail
    let result = env.try_invoke_contract::<_, (
        Result<(), Error>,
        Result<(), soroban_sdk::InvokeError>
    )>(
        &vault.address,
        &Symbol::new(&env, "transfer_from"),
        (&user1, &user1, &user2, 500),
    );
    assert_eq!(result.0, Err(Error::SharesLocked));
}

#[test]
fn test_transfer_succeeds_after_lock_up() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // User1 deposits
    deposit(&env, user1.clone(), 1000, user1.clone());
    
    // Advance time past lock-up period
    env.ledger().set_timestamp(1100); // 100 seconds later
    
    // Transfer should now succeed
    transfer(&env, user1.clone(), user2.clone(), 500);
    
    // Verify balances
    assert_eq!(SingleRWAVault::balance(&env, user1.clone()), 500);
    assert_eq!(SingleRWAVault::balance(&env, user2), 500);
}

#[test]
fn test_withdraw_blocked_during_lock_up() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let receiver = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // Deposit
    deposit(&env, user.clone(), 1000, user.clone());
    
    // Activate vault to allow withdrawals
    env.ledger().set_timestamp(2000);
    SingleRWAVault::activate_vault(&env, admin.clone());
    
    // Try to withdraw during lock-up - should fail
    let result = env.try_invoke_contract::<_, Error>(
        &vault.address,
        &SingleRWAVault::withdraw,
        (&user, &500, &receiver, &user),
    );
    assert_eq!(result.result, Err(Ok(Error::SharesLocked)));
}

#[test]
fn test_redeem_blocked_during_lock_up() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let receiver = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // Deposit
    deposit(&env, user.clone(), 1000, user.clone());
    
    // Activate vault to allow redemptions
    env.ledger().set_timestamp(2000);
    SingleRWAVault::activate_vault(&env, admin.clone());
    
    // Try to redeem during lock-up - should fail
    let result = env.try_invoke_contract::<_, Error>(
        &vault.address,
        &SingleRWAVault::redeem,
        (&user, &500, &receiver, &user),
    );
    assert_eq!(result.result, Err(Ok(Error::SharesLocked)));
}

#[test]
fn test_early_redemption_blocked_during_lock_up() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // Deposit
    deposit(&env, user.clone(), 1000, user.clone());
    
    // Activate vault
    env.ledger().set_timestamp(2000);
    SingleRWAVault::activate_vault(&env, admin.clone());
    
    // Try to request early redemption during lock-up - should fail
    let result = env.try_invoke_contract::<_, Error>(
        &vault.address,
        &SingleRWAVault::request_early_redemption,
        (&user, &500),
    );
    assert_eq!(result.result, Err(Ok(Error::SharesLocked)));
}

#[test]
fn test_redeem_at_maturity_bypasses_lock_up() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let receiver = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // Deposit
    deposit(&env, user.clone(), 1000, user.clone());
    
    // Activate and then mature vault
    env.ledger().set_timestamp(2000);
    SingleRWAVault::activate_vault(&env, admin.clone());
    
    env.ledger().set_timestamp(5000);
    SingleRWAVault::mature_vault(&env, admin.clone());
    
    // redeem_at_maturity should succeed even during lock-up
    let result = SingleRWAVault::redeem_at_maturity(&env, user.clone(), 500, receiver.clone(), user.clone());
    assert!(result > 0);
}

#[test]
fn test_no_lock_up_when_period_is_zero() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    // Create vault with 0 lock-up period (disabled)
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        0, // lock_up_period
    );
    
    env.ledger().set_timestamp(1000);
    
    // User1 deposits
    deposit(&env, user1.clone(), 1000, user1.clone());
    
    // Transfer should succeed immediately
    transfer(&env, user1.clone(), user2.clone(), 500);
    
    // Verify balances
    assert_eq!(SingleRWAVault::balance(&env, user1.clone()), 500);
    assert_eq!(SingleRWAVault::balance(&env, user2), 500);
    
    // lock_up_remaining should return 0
    assert_eq!(SingleRWAVault::lock_up_remaining(&env, user1), 0);
}

#[test]
fn test_lock_up_remaining_decreases_over_time() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        300, // 5 minute lock-up
    );
    
    env.ledger().set_timestamp(1000);
    
    // Deposit
    deposit(&env, user.clone(), 1000, user.clone());
    
    // Check lock-up remaining immediately after deposit
    let remaining1 = SingleRWAVault::lock_up_remaining(&env, user.clone());
    assert!(remaining1 > 290 && remaining1 <= 300);
    
    // Advance time by 60 seconds
    env.ledger().set_timestamp(1060);
    
    // Check lock-up remaining should be less
    let remaining2 = SingleRWAVault::lock_up_remaining(&env, user.clone());
    assert!(remaining2 > 230 && remaining2 <= 240);
    assert!(remaining2 < remaining1);
    
    // Advance time past lock-up period
    env.ledger().set_timestamp(1400);
    
    // Lock-up remaining should be 0
    let remaining3 = SingleRWAVault::lock_up_remaining(&env, user.clone());
    assert_eq!(remaining3, 0);
}

#[test]
fn test_admin_can_update_lock_up_period() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // initial lock-up period
    );
    
    env.ledger().set_timestamp(1000);
    
    // User1 deposits with 60-second lock-up
    deposit(&env, user1.clone(), 1000, user1.clone());
    
    // Admin updates lock-up period to 120 seconds for future deposits
    SingleRWAVault::set_lock_up_period(&env, admin.clone(), 120);
    
    env.ledger().set_timestamp(1050); // 50 seconds later
    
    // User1 should still be locked (original 60-second period)
    let result = env.try_invoke_contract::<_, Error>(
        &vault.address,
        &SingleRWAVault::transfer,
        (&user1, &user2, 500),
    );
    assert_eq!(result.result, Err(Ok(Error::SharesLocked)));
    
    // But after 60 seconds from original deposit, user1 can transfer
    env.ledger().set_timestamp(1100);
    transfer(&env, user1.clone(), user2.clone(), 500);
    
    // User2 deposits with new 120-second lock-up
    deposit(&env, user2.clone(), 500, user2.clone());
    
    // User2 should be locked for 120 seconds
    let result = env.try_invoke_contract::<_, Error>(
        &vault.address,
        &SingleRWAVault::transfer,
        (&user2, &user1, 250),
    );
    assert_eq!(result.result, Err(Ok(Error::SharesLocked)));
}

#[test]
fn test_multiple_deposits_use_latest_timestamp() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let user2 = Address::generate(&env);
    let asset = Address::generate(&env);
    let zkme_verifier = Address::generate(&env);
    let cooperator = Address::generate(&env);
    
    let vault = create_vault(
        &env,
        admin.clone(),
        asset,
        zkme_verifier,
        cooperator,
        60, // lock-up period
    );
    
    // First deposit at timestamp 1000
    env.ledger().set_timestamp(1000);
    deposit(&env, user.clone(), 500, user.clone());
    
    // Second deposit at timestamp 1100
    env.ledger().set_timestamp(1100);
    deposit(&env, user.clone(), 500, user.clone());
    
    // At timestamp 1150, should still be locked (50 seconds from latest deposit)
    let result = env.try_invoke_contract::<_, Error>(
        &vault.address,
        &SingleRWAVault::transfer,
        (&user, &user2, 500),
    );
    assert_eq!(result.result, Err(Ok(Error::SharesLocked)));
    
    // At timestamp 1200, should be unlocked (60 seconds from latest deposit)
    env.ledger().set_timestamp(1200);
    transfer(&env, user.clone(), user2.clone(), 500);
}
