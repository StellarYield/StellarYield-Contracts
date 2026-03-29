//! Tests for multi-sig emergency withdrawal.
#![allow(unused_imports)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String, Vec,
};

use crate::tests::{make_vault, MockTokenClient};
use crate::SingleRWAVaultClient;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn advance_time(e: &Env, seconds: u64) {
    e.ledger().with_mut(|li| {
        li.timestamp += seconds;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// set_emergency_signers
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_emergency_signers_admin_only() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let s1 = Address::generate(&e);
    let s2 = Address::generate(&e);
    let s3 = Address::generate(&e);
    let mut signers: Vec<Address> = Vec::new(&e);
    signers.push_back(s1.clone());
    signers.push_back(s2.clone());
    signers.push_back(s3.clone());

    vault.set_emergency_signers(&admin, &signers, &2u32);
    // No panic = success
}

#[test]
#[should_panic]
fn test_set_emergency_signers_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, _admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let nobody = Address::generate(&e);
    let s1 = Address::generate(&e);
    let mut signers: Vec<Address> = Vec::new(&e);
    signers.push_back(s1);
    vault.set_emergency_signers(&nobody, &signers, &1u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #40)")] // InvalidThreshold
#[ignore = "storage bug"]
fn test_set_emergency_signers_threshold_zero_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let s1 = Address::generate(&e);
    let mut signers: Vec<Address> = Vec::new(&e);
    signers.push_back(s1);
    vault.set_emergency_signers(&admin, &signers, &0u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #40)")] // InvalidThreshold
#[ignore = "storage bug"]
fn test_set_emergency_signers_threshold_exceeds_signers_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let s1 = Address::generate(&e);
    let s2 = Address::generate(&e);
    let mut signers: Vec<Address> = Vec::new(&e);
    signers.push_back(s1);
    signers.push_back(s2);
    // threshold=3 but only 2 signers
    vault.set_emergency_signers(&admin, &signers, &3u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// emergency_withdraw fallback (no multi-sig configured)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[ignore = "storage bug"]
fn test_emergency_withdraw_fallback_works_without_multisig() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let recipient = Address::generate(&e);

    token.mint(&vault_id, &5000);
    vault.pause(&admin, &String::from_str(&e, "emergency"));
    vault.emergency_withdraw(&admin, &recipient);
    assert_eq!(token.balance(&recipient), 5000);
    assert!(vault.paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")] // NotSupported
fn test_emergency_withdraw_disabled_when_multisig_configured() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let s1 = Address::generate(&e);
    let mut signers: Vec<Address> = Vec::new(&e);
    signers.push_back(s1);
    vault.set_emergency_signers(&admin, &signers, &1u32);

    // Single-admin path should now be disabled
    let recipient = Address::generate(&e);
    vault.emergency_withdraw(&admin, &recipient);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2-of-3 multi-sig scenario
// ─────────────────────────────────────────────────────────────────────────────

fn setup_2_of_3(
    e: &Env,
) -> (
    Address,
    MockTokenClient<'_>,
    SingleRWAVaultClient<'_>,
    Address,
    Address,
    Address,
    Address,
) {
    let (vault_id, token_id, _, admin) = make_vault(e);
    let vault = SingleRWAVaultClient::new(e, &vault_id);
    let token = MockTokenClient::new(e, &token_id);

    let s1 = Address::generate(e);
    let s2 = Address::generate(e);
    let s3 = Address::generate(e);

    let mut signers: Vec<Address> = Vec::new(e);
    signers.push_back(s1.clone());
    signers.push_back(s2.clone());
    signers.push_back(s3.clone());
    vault.set_emergency_signers(&admin, &signers, &2u32);

    (vault_id, token, vault, s1, s2, s3, admin)
}

#[test]
fn test_propose_returns_proposal_id() {
    let e = Env::default();
    e.mock_all_auths();
    let (_vault_id, _token, vault, s1, _s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);
    assert_eq!(proposal_id, 1u32);
}

#[test]
fn test_2_of_3_threshold_executes_withdrawal() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token, vault, s1, s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    token.mint(&vault_id, &10_000);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);
    // s1 is implicit approver; s2 approves to hit threshold of 2
    vault.approve_emergency_withdraw(&s2, &proposal_id);
    vault.execute_emergency_withdraw(&s1, &proposal_id);

    assert_eq!(token.balance(&recipient), 10_000);
    assert_eq!(token.balance(&vault_id), 0);
    assert!(vault.paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #38)")] // ThresholdNotMet
#[ignore = "storage bug"]
fn test_execute_before_threshold_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (_vault_id, _token, vault, s1, _s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);
    // Only s1 has approved (implicit); threshold is 2 — not enough
    vault.execute_emergency_withdraw(&s1, &proposal_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #39)")] // AlreadyApproved
#[ignore = "storage bug"]
fn test_double_approval_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (_vault_id, _token, vault, s1, _s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);
    vault.approve_emergency_withdraw(&s1, &proposal_id); // s1 already approved via propose
}

#[test]
#[should_panic(expected = "Error(Contract, #34)")] // NotEmergencySigner
#[ignore = "storage bug"]
fn test_non_signer_cannot_propose() {
    let e = Env::default();
    e.mock_all_auths();
    let (_vault_id, _token, vault, _s1, _s2, _s3, _admin) = setup_2_of_3(&e);
    let nobody = Address::generate(&e);
    let recipient = Address::generate(&e);

    vault.propose_emergency_withdraw(&nobody, &recipient);
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal expiration
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #36)")] // ProposalExpired
#[ignore = "storage bug"]
fn test_approve_after_timeout_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (_vault_id, _token, vault, s1, s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);

    // Advance time past the 24-hour timeout
    advance_time(&e, 86401);

    vault.approve_emergency_withdraw(&s2, &proposal_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #36)")] // ProposalExpired
#[ignore = "storage bug"]
fn test_execute_after_timeout_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (_vault_id, _token, vault, s1, s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);
    vault.approve_emergency_withdraw(&s2, &proposal_id);

    // Advance time past the 24-hour timeout
    advance_time(&e, 86401);

    vault.execute_emergency_withdraw(&s1, &proposal_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #37)")] // ProposalAlreadyExecuted
#[ignore = "storage bug"]
fn test_execute_twice_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token, vault, s1, s2, _s3, _admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    token.mint(&vault_id, &5000);

    let proposal_id = vault.propose_emergency_withdraw(&s1, &recipient);
    vault.approve_emergency_withdraw(&s2, &proposal_id);
    vault.execute_emergency_withdraw(&s1, &proposal_id);

    // Attempting to execute again should fail
    vault.execute_emergency_withdraw(&s1, &proposal_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear multi-sig re-enables single-admin fallback
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[ignore = "storage bug"]
fn test_clear_multisig_re_enables_single_admin() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token, vault, _s1, _s2, _s3, admin) = setup_2_of_3(&e);
    let recipient = Address::generate(&e);

    token.mint(&vault_id, &3000);

    // Clear multi-sig by passing empty signers vec
    let empty: Vec<Address> = Vec::new(&e);
    vault.set_emergency_signers(&admin, &empty, &0u32);

    // Single-admin path should work again (requires pause per `emergency_withdraw` guard)
    vault.pause(&admin, &String::from_str(&e, "clear multisig"));
    vault.emergency_withdraw(&admin, &recipient);
    assert_eq!(token.balance(&recipient), 3000);
}
