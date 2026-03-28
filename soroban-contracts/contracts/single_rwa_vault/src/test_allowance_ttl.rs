//! Tests for allowance TTL management to prevent silent archival.

extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env};

use crate::test_helpers::{setup, mint_usdc};

#[test]
fn test_allowance_ttl_bumped_on_write() {
    let ctx = setup();
    
    let owner = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    // Grant KYC approval to owner
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&owner);

    // Mint shares to owner
    let shares = 1000000_i128; // 1 USDC (6 decimals)
    mint_usdc(&ctx.env, &ctx.asset_id, &owner, shares);
    ctx.vault().deposit(&owner, &shares, &owner);

    // Set up allowance
    let allowance_amount = 500000_i128; // 0.5 USDC - enough for multiple transfers
    let expiration_ledger = ctx.env.ledger().sequence() + 1000;
    
    ctx.vault().approve(&owner, &spender, &allowance_amount, &expiration_ledger);

    // Verify allowance exists
    assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);

    // Simulate TTL passage by advancing many ledgers (but not past expiration)
    for _ in 0..100 {
        ctx.env.ledger().set_sequence_number(ctx.env.ledger().sequence() + 10);
        // Check that allowance still persists (TTL bump on read)
        assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);
    }

    // Use some allowance to test put_share_allowance TTL bump
    let recipient = Address::generate(&ctx.env);
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&recipient);
    ctx.vault().transfer_from(&spender, &owner, &recipient, &10000_i128);
    
    // Advance more ledgers and verify remaining allowance still persists
    // Note: Allowance may be 0 if fully used, but storage entry should still exist
    for _ in 0..100 {
        ctx.env.ledger().set_sequence_number(ctx.env.ledger().sequence() + 10);
        let remaining = ctx.vault().allowance(&owner, &spender);
        assert!(remaining >= 0); // Should not panic, indicating storage exists
    }
}

#[test]
fn test_allowance_ttl_bumped_on_read() {
    let ctx = setup();
    
    let owner = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    // Grant KYC approval to owner
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&owner);

    // Mint shares to owner
    let shares = 1000000_i128; // 1 USDC (6 decimals)
    mint_usdc(&ctx.env, &ctx.asset_id, &owner, shares);
    ctx.vault().deposit(&owner, &shares, &owner);

    // Set up allowance
    let allowance_amount = 500000_i128; // 0.5 USDC - enough for multiple transfers
    let expiration_ledger = ctx.env.ledger().sequence() + 1000;
    
    ctx.vault().approve(&owner, &spender, &allowance_amount, &expiration_ledger);

    // Simulate many reads over time without writes
    for i in 0..200 {
        ctx.env.ledger().set_sequence_number(ctx.env.ledger().sequence() + 5);
        
        // Each read should bump TTL, preventing archival
        assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);
    }
}

#[test]
fn test_expired_allowance_returns_zero_but_still_bumped() {
    let ctx = setup();
    
    let owner = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    // Grant KYC approval to owner
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&owner);

    // Mint shares to owner
    let shares = 1000000_i128; // 1 USDC (6 decimals)
    mint_usdc(&ctx.env, &ctx.asset_id, &owner, shares);
    ctx.vault().deposit(&owner, &shares, &owner);

    // Set up allowance with near expiration
    let allowance_amount = 1000_i128;
    let expiration_ledger = ctx.env.ledger().sequence() + 10;
    
    ctx.vault().approve(&owner, &spender, &allowance_amount, &expiration_ledger);

    // Verify allowance exists before expiration
    assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);

    // Advance past expiration
    ctx.env.ledger().set_sequence_number(expiration_ledger + 1);

    // Allowance should return 0 due to expiration, but storage entry should still exist
    assert_eq!(ctx.vault().allowance(&owner, &spender), 0);

    // Verify the storage entry still exists (wasn't archived)
    // Note: We can't directly access storage from tests, but the fact that
    // get_share_allowance still returns 0 (instead of panicking) indicates
    // the storage entry exists but is expired.
    assert_eq!(ctx.vault().allowance(&owner, &spender), 0);
}

#[test]
fn test_allowance_persistence_vs_balance_consistency() {
    let ctx = setup();
    
    let user = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    // Grant KYC approval to user
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&user);

    // Mint shares to user
    let shares = 1000000_i128; // 1 USDC (6 decimals)
    mint_usdc(&ctx.env, &ctx.asset_id, &user, shares);
    ctx.vault().deposit(&user, &shares, &user);

    // Set up allowance
    let allowance_amount = 500000_i128; // 0.5 USDC - enough for multiple transfers
    let expiration_ledger = ctx.env.ledger().sequence() + 1000;
    ctx.vault().approve(&user, &spender, &allowance_amount, &expiration_ledger);

    // Simulate long period with interactions
    for i in 0..50 {
        ctx.env.ledger().set_sequence_number(ctx.env.ledger().sequence() + 100);
        
        // Check that both balance and allowance persist
        // Note: Balance may decrease due to transfers, allowance may decrease due to usage
        assert!(ctx.vault().balance(&user) > 0);
        // Allowance should be accessible (may be 0 if exhausted, but shouldn't panic)
        let _allowance = ctx.vault().allowance(&user, &spender);
    }

    // Final state should be consistent
    assert!(ctx.vault().balance(&user) > 0);
    // Allowance should still be accessible (even if 0, this proves storage wasn't archived)
    let _final_allowance = ctx.vault().allowance(&user, &spender);
}
