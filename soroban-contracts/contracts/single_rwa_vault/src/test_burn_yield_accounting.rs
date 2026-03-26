//! Tests for burn/burn_from yield accounting via epoch snapshots.
//!
//! Burn snapshots the caller's balance before reducing it so that epoch yield
//! is correctly attributed to the pre-burn share count.  Yield is NOT
//! auto-claimed; users claim explicitly after burning.

use crate::tests::make_vault;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_burn_snapshots_yield_for_explicit_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true);
    vault.activate_vault(&admin);

    // Deposit and create yield
    token.mint(&user, &10_000i128);
    vault.deposit(&user, &10_000i128, &user);
    token.mint(&operator, &2_000i128);
    vault.distribute_yield(&operator, &2_000i128);

    let shares_before = vault.balance(&user);
    let pending_before = vault.pending_yield(&user);
    assert!(shares_before > 0);
    assert!(pending_before > 0);

    // Burn half the shares; snapshot is taken, yield is NOT auto-claimed
    let burn_amount = shares_before / 2;
    vault.burn(&user, &burn_amount);

    // Verify: pending yield is still available (not auto-claimed)
    assert_eq!(vault.pending_yield(&user), pending_before);
    // Verify remaining shares
    assert_eq!(vault.balance(&user), shares_before - burn_amount);

    // User explicitly claims yield after burn
    vault.claim_yield(&user);
    assert_eq!(vault.pending_yield(&user), 0);
    assert!(token.balance(&user) > 0);
}

#[test]
fn test_burn_from_snapshots_yield_for_explicit_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let spender = Address::generate(&env);
    let operator = Address::generate(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true);
    vault.activate_vault(&admin);

    // Deposit and create yield
    token.mint(&user, &10_000i128);
    vault.deposit(&user, &10_000i128, &user);
    token.mint(&operator, &2_000i128);
    vault.distribute_yield(&operator, &2_000i128);

    // User authorizes spender
    let shares_before = vault.balance(&user);
    let pending_before = vault.pending_yield(&user);
    vault.approve(&user, &spender, &shares_before, &999_999u32);

    // spender burns half the shares; snapshot is taken, yield is NOT auto-claimed
    let burn_amount = shares_before / 2;
    vault.burn_from(&spender, &user, &burn_amount);

    // Verify: pending yield is still available (not auto-claimed)
    assert_eq!(vault.pending_yield(&user), pending_before);
    // Verify remaining shares and allowance
    assert_eq!(vault.balance(&user), shares_before - burn_amount);
    assert_eq!(
        vault.allowance(&user, &spender),
        shares_before - burn_amount
    );

    // User explicitly claims yield after burn
    vault.claim_yield(&user);
    assert_eq!(vault.pending_yield(&user), 0);
}

#[test]
fn test_burn_with_no_pending_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let user = Address::generate(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    zkme.approve_user(&user);

    // Deposit without yield
    token.mint(&user, &5_000i128);
    vault.deposit(&user, &5_000i128, &user);

    let shares_before = vault.balance(&user);
    let pending_before = vault.pending_yield(&user);
    assert_eq!(pending_before, 0);

    // Burn some shares; should not attempt claim
    let burn_amount = 1_000i128;
    vault.burn(&user, &burn_amount);

    // Verify: no yield claimed, pending remains 0
    assert_eq!(vault.pending_yield(&user), 0);
    // Verify: assets unchanged for user (no yield to claim)
    assert_eq!(vault.balance(&user), shares_before - burn_amount);
}
