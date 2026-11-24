use crate::test_helpers::*;
use soroban_sdk::{testutils::Address as _, vec, Address, String, Vec};

#[test]
fn test_can_redeem_success() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    // Mint tokens and deposit the full funding target (100 USDC) to allow activation.
    asset.mint(&user, &200_000_000);
    vault.deposit(&user, &100_000_000, &user);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Check if user can redeem
    let result = vault.can_redeem(&user, &10_000_000);
    assert!(result.ok);
    assert!(result.reason.is_none());
}

#[test]
fn test_can_redeem_insufficient_shares() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    // Mint tokens and deposit the full funding target to allow activation.
    asset.mint(&user, &200_000_000);
    vault.deposit(&user, &100_000_000, &user);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Try to redeem more than balance (user has 100M shares, requests 200M)
    let result = vault.can_redeem(&user, &200_000_000);
    assert!(!result.ok);
    assert!(result.reason.is_some());
    assert_eq!(
        result.reason.unwrap(),
        String::from_str(&ctx.env, "Insufficient shares")
    );
}

#[test]
fn test_can_redeem_vault_paused() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    // Mint tokens and deposit the full funding target to allow activation.
    asset.mint(&user, &200_000_000);
    vault.deposit(&user, &100_000_000, &user);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Pause vault
    vault.pause(&ctx.admin, &String::from_str(&ctx.env, "Testing"));

    // Try to redeem while paused
    let result = vault.can_redeem(&user, &10_000_000);
    assert!(!result.ok);
    assert!(result.reason.is_some());
    assert_eq!(
        result.reason.unwrap(),
        String::from_str(&ctx.env, "Vault is paused")
    );
}

#[test]
fn test_can_redeem_wrong_state() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    // Mint and deposit less than the funding target — vault stays in Funding state.
    asset.mint(&user, &200_000_000);
    vault.deposit(&user, &50_000_000, &user);

    // Vault is still in Funding state (not activated)
    let result = vault.can_redeem(&user, &10_000_000);
    assert!(!result.ok);
    assert!(result.reason.is_some());
    assert_eq!(
        result.reason.unwrap(),
        String::from_str(&ctx.env, "Vault not active or matured")
    );
}

#[test]
fn test_can_redeem_blacklisted_user() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    // Mint tokens and deposit the full funding target to allow activation.
    asset.mint(&user, &200_000_000);
    vault.deposit(&user, &100_000_000, &user);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Blacklist user
    vault.set_blacklisted(&ctx.admin, &user, &true);

    // Try to redeem while blacklisted
    let result = vault.can_redeem(&user, &10_000_000);
    assert!(!result.ok);
    assert!(result.reason.is_some());
    assert_eq!(
        result.reason.unwrap(),
        String::from_str(&ctx.env, "User is blacklisted")
    );
}

#[test]
fn test_can_redeem_with_escrowed_shares() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    // Mint tokens and deposit the full funding target to allow activation.
    asset.mint(&user, &200_000_000);
    vault.deposit(&user, &100_000_000, &user);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Request early redemption (this escrows shares)
    // After this: balance = 20_000_000, escrowed = 80_000_000
    vault.request_early_redemption(&user, &80_000_000);

    // Try to redeem more than available balance (20M < 25M)
    let result = vault.can_redeem(&user, &25_000_000);
    assert!(!result.ok);
    assert!(result.reason.is_some());
    // Since balance (20M) < requested (25M), it's insufficient shares
    assert_eq!(
        result.reason.unwrap(),
        String::from_str(&ctx.env, "Insufficient shares")
    );

    // Try to redeem within available amount (balance = 20M)
    let result2 = vault.can_redeem(&user, &15_000_000);
    assert!(result2.ok);
    assert!(result2.reason.is_none());
}

// ============================================================================
// can_redeem_many tests
// ============================================================================

#[test]
fn test_can_redeem_many_all_success() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);
    let user3 = Address::generate(&ctx.env);

    // Setup: mint and deposit for all users
    asset.mint(&user1, &50_000_000);
    asset.mint(&user2, &30_000_000);
    asset.mint(&user3, &20_000_000);

    vault.deposit(&user1, &50_000_000, &user1);
    vault.deposit(&user2, &30_000_000, &user2);
    vault.deposit(&user3, &20_000_000, &user3);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Check multiple users can redeem
    let users: Vec<Address> = vec![&ctx.env, user1.clone(), user2.clone(), user3.clone()];
    let shares: Vec<i128> = vec![&ctx.env, 10_000_000, 15_000_000, 5_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    assert_eq!(results.len(), 3);

    // All should succeed
    assert!(results.get(0).unwrap().can_redeem);
    assert_eq!(results.get(0).unwrap().user, user1);
    assert_eq!(results.get(0).unwrap().shares, 10_000_000);
    assert_eq!(results.get(0).unwrap().reason, String::from_str(&ctx.env, ""));

    assert!(results.get(1).unwrap().can_redeem);
    assert_eq!(results.get(1).unwrap().user, user2);
    assert_eq!(results.get(1).unwrap().shares, 15_000_000);
    assert_eq!(results.get(1).unwrap().reason, String::from_str(&ctx.env, ""));

    assert!(results.get(2).unwrap().can_redeem);
    assert_eq!(results.get(2).unwrap().user, user3);
    assert_eq!(results.get(2).unwrap().shares, 5_000_000);
    assert_eq!(results.get(2).unwrap().reason, String::from_str(&ctx.env, ""));
}

#[test]
fn test_can_redeem_many_mixed_results() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user_success = Address::generate(&ctx.env);
    let user_insufficient = Address::generate(&ctx.env);
    let user_blacklisted = Address::generate(&ctx.env);
    let user_zero_shares = Address::generate(&ctx.env);

    // Setup: mint and deposit
    asset.mint(&user_success, &50_000_000);
    asset.mint(&user_insufficient, &10_000_000);
    asset.mint(&user_blacklisted, &30_000_000);
    asset.mint(&user_zero_shares, &10_000_000);

    vault.deposit(&user_success, &50_000_000, &user_success);
    vault.deposit(&user_insufficient, &10_000_000, &user_insufficient);
    vault.deposit(&user_blacklisted, &30_000_000, &user_blacklisted);
    vault.deposit(&user_zero_shares, &10_000_000, &user_zero_shares);

    // Activate vault
    vault.activate_vault(&ctx.admin);

    // Blacklist one user
    vault.set_blacklisted(&ctx.admin, &user_blacklisted, &true);

    // Test with mixed scenarios
    let users: Vec<Address> = vec![
        &ctx.env,
        user_success.clone(),
        user_insufficient.clone(),
        user_blacklisted.clone(),
        user_zero_shares.clone(),
    ];
    let shares: Vec<i128> = vec![
        &ctx.env,
        20_000_000,  // user_success has 50M, requesting 20M - OK
        50_000_000,  // user_insufficient has 10M, requesting 50M - FAIL
        10_000_000,  // user_blacklisted is blacklisted - FAIL
        0,           // user_zero_shares requesting 0 - FAIL
    ];

    let results = vault.can_redeem_many(&users, &shares);

    assert_eq!(results.len(), 4);

    // Result 0: Success
    let r0 = results.get(0).unwrap();
    assert!(r0.can_redeem);
    assert_eq!(r0.user, user_success);
    assert_eq!(r0.shares, 20_000_000);
    assert_eq!(r0.reason, String::from_str(&ctx.env, ""));
    assert_eq!(r0.assets_out, 20_000_000); // 1:1 conversion

    // Result 1: Insufficient balance
    let r1 = results.get(1).unwrap();
    assert!(!r1.can_redeem);
    assert_eq!(r1.user, user_insufficient);
    assert_eq!(r1.shares, 50_000_000);
    assert_eq!(r1.reason, String::from_str(&ctx.env, "insufficient_balance"));
    assert_eq!(r1.assets_out, 0);

    // Result 2: Blacklisted
    let r2 = results.get(2).unwrap();
    assert!(!r2.can_redeem);
    assert_eq!(r2.user, user_blacklisted);
    assert_eq!(r2.shares, 10_000_000);
    assert_eq!(r2.reason, String::from_str(&ctx.env, "user_blacklisted"));
    assert_eq!(r2.assets_out, 0);

    // Result 3: Zero shares
    let r3 = results.get(3).unwrap();
    assert!(!r3.can_redeem);
    assert_eq!(r3.user, user_zero_shares);
    assert_eq!(r3.shares, 0);
    assert_eq!(r3.reason, String::from_str(&ctx.env, "zero_or_negative_shares"));
    assert_eq!(r3.assets_out, 0);
}

#[test]
fn test_can_redeem_many_input_ordering_preserved() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);
    let user3 = Address::generate(&ctx.env);
    let user4 = Address::generate(&ctx.env);
    let user5 = Address::generate(&ctx.env);

    // Setup: deposit for all users
    for user in [&user1, &user2, &user3, &user4, &user5] {
        asset.mint(user, &100_000_000);
        vault.deposit(user, &100_000_000, user);
    }

    vault.activate_vault(&ctx.admin);

    // Test with specific ordering that should be preserved
    let users: Vec<Address> = vec![
        &ctx.env,
        user3.clone(),
        user1.clone(),
        user5.clone(),
        user2.clone(),
        user4.clone(),
    ];
    let shares: Vec<i128> = vec![&ctx.env, 10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    // Verify order is preserved
    assert_eq!(results.len(), 5);
    assert_eq!(results.get(0).unwrap().user, user3);
    assert_eq!(results.get(0).unwrap().shares, 10_000_000);
    
    assert_eq!(results.get(1).unwrap().user, user1);
    assert_eq!(results.get(1).unwrap().shares, 20_000_000);
    
    assert_eq!(results.get(2).unwrap().user, user5);
    assert_eq!(results.get(2).unwrap().shares, 30_000_000);
    
    assert_eq!(results.get(3).unwrap().user, user2);
    assert_eq!(results.get(3).unwrap().shares, 40_000_000);
    
    assert_eq!(results.get(4).unwrap().user, user4);
    assert_eq!(results.get(4).unwrap().shares, 50_000_000);

    // All should succeed
    for i in 0..5 {
        assert!(results.get(i).unwrap().can_redeem);
    }
}

#[test]
fn test_can_redeem_many_same_user_multiple_times() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    asset.mint(&user, &100_000_000);
    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);

    // Same user, different amounts in different positions
    let users: Vec<Address> = vec![&ctx.env, user.clone(), user.clone(), user.clone()];
    let shares: Vec<i128> = vec![&ctx.env, 10_000_000, 20_000_000, 30_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    assert_eq!(results.len(), 3);

    // All should succeed since user has 100M shares
    assert!(results.get(0).unwrap().can_redeem);
    assert_eq!(results.get(0).unwrap().shares, 10_000_000);
    assert_eq!(results.get(0).unwrap().assets_out, 10_000_000);

    assert!(results.get(1).unwrap().can_redeem);
    assert_eq!(results.get(1).unwrap().shares, 20_000_000);
    assert_eq!(results.get(1).unwrap().assets_out, 20_000_000);

    assert!(results.get(2).unwrap().can_redeem);
    assert_eq!(results.get(2).unwrap().shares, 30_000_000);
    assert_eq!(results.get(2).unwrap().assets_out, 30_000_000);
}

#[test]
fn test_can_redeem_many_vault_paused_affects_all() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);

    asset.mint(&user1, &100_000_000);
    asset.mint(&user2, &100_000_000);
    vault.deposit(&user1, &100_000_000, &user1);
    vault.deposit(&user2, &100_000_000, &user2);

    vault.activate_vault(&ctx.admin);

    // Pause the vault
    vault.pause(&ctx.admin, &String::from_str(&ctx.env, "Emergency"));

    let users: Vec<Address> = vec![&ctx.env, user1.clone(), user2.clone()];
    let shares: Vec<i128> = vec![&ctx.env, 10_000_000, 20_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    // All should fail with vault_paused reason
    assert_eq!(results.len(), 2);
    
    let r0 = results.get(0).unwrap();
    assert!(!r0.can_redeem);
    assert_eq!(r0.reason, String::from_str(&ctx.env, "vault_paused"));

    let r1 = results.get(1).unwrap();
    assert!(!r1.can_redeem);
    assert_eq!(r1.reason, String::from_str(&ctx.env, "vault_paused"));
}

#[test]
fn test_can_redeem_many_invalid_vault_state() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);

    // Deposit but don't activate (vault stays in Funding state)
    asset.mint(&user1, &50_000_000);
    asset.mint(&user2, &30_000_000);
    vault.deposit(&user1, &50_000_000, &user1);
    vault.deposit(&user2, &30_000_000, &user2);

    let users: Vec<Address> = vec![&ctx.env, user1.clone(), user2.clone()];
    let shares: Vec<i128> = vec![&ctx.env, 10_000_000, 15_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    // All should fail with invalid_vault_state reason
    assert_eq!(results.len(), 2);
    
    let r0 = results.get(0).unwrap();
    assert!(!r0.can_redeem);
    assert_eq!(r0.reason, String::from_str(&ctx.env, "invalid_vault_state"));

    let r1 = results.get(1).unwrap();
    assert!(!r1.can_redeem);
    assert_eq!(r1.reason, String::from_str(&ctx.env, "invalid_vault_state"));
}

#[test]
fn test_can_redeem_many_with_escrowed_shares() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);

    asset.mint(&user1, &100_000_000);
    asset.mint(&user2, &100_000_000);
    vault.deposit(&user1, &100_000_000, &user1);
    vault.deposit(&user2, &100_000_000, &user2);

    vault.activate_vault(&ctx.admin);

    // User1 escrows 80M shares (20M available)
    vault.request_early_redemption(&user1, &80_000_000);

    let users: Vec<Address> = vec![&ctx.env, user1.clone(), user2.clone(), user1.clone()];
    let shares: Vec<i128> = vec![
        &ctx.env,
        15_000_000,  // user1 requesting 15M (has 20M available) - OK
        50_000_000,  // user2 requesting 50M (has 100M) - OK
        30_000_000,  // user1 requesting 30M (only 20M available) - FAIL
    ];

    let results = vault.can_redeem_many(&users, &shares);

    assert_eq!(results.len(), 3);

    // Result 0: user1 with 15M - should succeed
    let r0 = results.get(0).unwrap();
    assert!(r0.can_redeem);
    assert_eq!(r0.user, user1);
    assert_eq!(r0.shares, 15_000_000);

    // Result 1: user2 with 50M - should succeed
    let r1 = results.get(1).unwrap();
    assert!(r1.can_redeem);
    assert_eq!(r1.user, user2);
    assert_eq!(r1.shares, 50_000_000);

    // Result 2: user1 with 30M - should fail (only 20M available)
    let r2 = results.get(2).unwrap();
    assert!(!r2.can_redeem);
    assert_eq!(r2.user, user1);
    assert_eq!(r2.shares, 30_000_000);
    assert_eq!(r2.reason, String::from_str(&ctx.env, "insufficient_balance"));
}

#[test]
fn test_can_redeem_many_negative_shares() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);

    asset.mint(&user1, &100_000_000);
    asset.mint(&user2, &100_000_000);
    vault.deposit(&user1, &100_000_000, &user1);
    vault.deposit(&user2, &100_000_000, &user2);

    vault.activate_vault(&ctx.admin);

    let users: Vec<Address> = vec![&ctx.env, user1.clone(), user2.clone()];
    let shares: Vec<i128> = vec![&ctx.env, -10_000_000, 20_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    assert_eq!(results.len(), 2);

    // Result 0: negative shares - should fail
    let r0 = results.get(0).unwrap();
    assert!(!r0.can_redeem);
    assert_eq!(r0.shares, -10_000_000);
    assert_eq!(r0.reason, String::from_str(&ctx.env, "zero_or_negative_shares"));

    // Result 1: positive shares - should succeed
    let r1 = results.get(1).unwrap();
    assert!(r1.can_redeem);
    assert_eq!(r1.shares, 20_000_000);
}

#[test]
fn test_can_redeem_many_single_user() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let asset = ctx.asset();

    let user = Address::generate(&ctx.env);

    asset.mint(&user, &100_000_000);
    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);

    // Single user in batch
    let users: Vec<Address> = vec![&ctx.env, user.clone()];
    let shares: Vec<i128> = vec![&ctx.env, 50_000_000];

    let results = vault.can_redeem_many(&users, &shares);

    assert_eq!(results.len(), 1);

    let r0 = results.get(0).unwrap();
    assert!(r0.can_redeem);
    assert_eq!(r0.user, user);
    assert_eq!(r0.shares, 50_000_000);
    assert_eq!(r0.assets_out, 50_000_000);
}

#[test]
#[should_panic(expected = "InvalidInitParams")]
fn test_can_redeem_many_mismatched_lengths() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);

    let users: Vec<Address> = vec![&ctx.env, user1, user2];
    let shares: Vec<i128> = vec![&ctx.env, 10_000_000]; // Only 1 share value for 2 users

    // Should panic due to length mismatch
    vault.can_redeem_many(&users, &shares);
}

#[test]
#[should_panic(expected = "InvalidInitParams")]
fn test_can_redeem_many_exceeds_max_batch_size() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    // Create 101 users (exceeds MAX_BATCH_SIZE of 100)
    let mut users: Vec<Address> = Vec::new(&ctx.env);
    let mut shares: Vec<i128> = Vec::new(&ctx.env);

    for _ in 0..101 {
        users.push_back(Address::generate(&ctx.env));
        shares.push_back(10_000_000);
    }

    // Should panic due to batch size limit
    vault.can_redeem_many(&users, &shares);
}
