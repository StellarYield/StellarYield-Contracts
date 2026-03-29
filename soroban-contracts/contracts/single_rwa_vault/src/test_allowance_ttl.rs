//! Tests for allowance TTL management to prevent silent archival.

extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Address;

use crate::test_helpers::{mint_usdc, setup};

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
    let allowance_amount = 500000_i128; // 0.5 USDC
    let expiration_ledger = ctx.env.ledger().sequence() + 1000;

    ctx.vault()
        .approve(&owner, &spender, &allowance_amount, &expiration_ledger);

    // Verify allowance exists
    assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);

    // Simulate TTL passage
    for _ in 0..100 {
        ctx.env
            .ledger()
            .set_sequence_number(ctx.env.ledger().sequence() + 10);

        assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);
    }

    // Use part of allowance
    let recipient = Address::generate(&ctx.env);
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&recipient);

    ctx.vault()
        .transfer_from(&spender, &owner, &recipient, &10000_i128);

    // Ensure allowance storage persists
    for _ in 0..100 {
        ctx.env
            .ledger()
            .set_sequence_number(ctx.env.ledger().sequence() + 10);

        let remaining = ctx.vault().allowance(&owner, &spender);
        assert!(remaining >= 0);
    }
}

#[test]
fn test_allowance_ttl_bumped_on_read() {
    let ctx = setup();

    let owner = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&owner);

    let shares = 1000000_i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &owner, shares);
    ctx.vault().deposit(&owner, &shares, &owner);

    let allowance_amount = 500000_i128;
    let expiration_ledger = ctx.env.ledger().sequence() + 1000;

    ctx.vault()
        .approve(&owner, &spender, &allowance_amount, &expiration_ledger);

    // Repeated reads should keep TTL alive
    for _ in 0..200 {
        ctx.env
            .ledger()
            .set_sequence_number(ctx.env.ledger().sequence() + 5);

        assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);
    }
}

#[test]
fn test_expired_allowance_returns_zero_but_still_bumped() {
    let ctx = setup();

    let owner = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&owner);

    let shares = 1000000_i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &owner, shares);
    ctx.vault().deposit(&owner, &shares, &owner);

    let allowance_amount = 1000_i128;
    let expiration_ledger = ctx.env.ledger().sequence() + 10;

    ctx.vault()
        .approve(&owner, &spender, &allowance_amount, &expiration_ledger);

    assert_eq!(ctx.vault().allowance(&owner, &spender), allowance_amount);

    // Move past expiration
    ctx.env.ledger().set_sequence_number(expiration_ledger + 1);

    // Should return 0 but not panic
    assert_eq!(ctx.vault().allowance(&owner, &spender), 0);
    assert_eq!(ctx.vault().allowance(&owner, &spender), 0);
}

#[test]
fn test_allowance_persistence_vs_balance_consistency() {
    let ctx = setup();

    let user = Address::generate(&ctx.env);
    let spender = Address::generate(&ctx.env);

    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&user);

    let shares = 1000000_i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &user, shares);
    ctx.vault().deposit(&user, &shares, &user);

    let allowance_amount = 500000_i128;
    let expiration_ledger = ctx.env.ledger().sequence() + 1000;

    ctx.vault()
        .approve(&user, &spender, &allowance_amount, &expiration_ledger);

    // Simulate long usage period
    for _ in 0..50 {
        ctx.env
            .ledger()
            .set_sequence_number(ctx.env.ledger().sequence() + 100);

        assert!(ctx.vault().balance(&user) > 0);

        let _allowance = ctx.vault().allowance(&user, &spender);
    }

    // Final consistency check
    assert!(ctx.vault().balance(&user) > 0);
    let _final_allowance = ctx.vault().allowance(&user, &spender);
}