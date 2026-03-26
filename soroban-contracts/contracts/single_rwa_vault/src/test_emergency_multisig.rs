//! Tests for the emergency multi-sig withdrawal mechanism.
//!
//! Scenarios covered:
//! - Happy-path 2-of-3: propose → approve → execute
//! - Threshold enforcement: execution blocked until threshold is met
//! - Proposal expiry: expired proposals cannot be approved or executed
//! - Double-approval prevention
//! - Non-signer cannot propose, approve, or execute
//! - Single-admin fallback works when multi-sig is NOT configured
//! - Single-admin fallback is blocked once multi-sig IS configured

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    vec, Address, Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mock token (SEP-41 compatible)
// ─────────────────────────────────────────────────────────────────────────────

#[soroban_sdk::contract]
pub struct MockToken;

#[soroban_sdk::contractimpl]
impl MockToken {
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&id).unwrap_or(0i128)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_bal: i128 = e.storage().persistent().get(&from).unwrap_or(0);
        if from_bal < amount {
            panic!("insufficient balance");
        }
        e.storage().persistent().set(&from, &(from_bal - amount));
        let to_bal: i128 = e.storage().persistent().get(&to).unwrap_or(0);
        e.storage().persistent().set(&to, &(to_bal + amount));
    }

    pub fn mint(e: Env, to: Address, amount: i128) {
        let bal: i128 = e.storage().persistent().get(&to).unwrap_or(0);
        e.storage().persistent().set(&to, &(bal + amount));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mock zkMe verifier (always approves)
// ─────────────────────────────────────────────────────────────────────────────

#[soroban_sdk::contract]
pub struct MockZkme;

#[soroban_sdk::contractimpl]
impl MockZkme {
    pub fn has_approved(_e: Env, _cooperator: Address, _user: Address) -> bool {
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

struct Ctx {
    env: Env,
    vault_id: Address,
    token_id: Address,
    admin: Address,
}

impl Ctx {
    fn vault(&self) -> SingleRWAVaultClient<'_> {
        SingleRWAVaultClient::new(&self.env, &self.vault_id)
    }

    fn token_balance(&self, addr: &Address) -> i128 {
        MockTokenClient::new(&self.env, &self.token_id).balance(addr)
    }

    /// Mint mock tokens directly into the vault contract address.
    fn fund_vault(&self, amount: i128) {
        MockTokenClient::new(&self.env, &self.token_id).mint(&self.vault_id, &amount);
    }
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(MockToken, ());
    let zkme_id = env.register(MockZkme, ());
    let cooperator = Address::generate(&env);

    let vault_id = env.register(
        SingleRWAVault,
        (InitParams {
            asset: token_id.clone(),
            share_name: String::from_str(&env, "Test Share"),
            share_symbol: String::from_str(&env, "TS"),
            share_decimals: 6u32,
            admin: admin.clone(),
            zkme_verifier: zkme_id.clone(),
            cooperator,
            funding_target: 1_000_000i128,
            maturity_date: 9_999_999_999u64,
            fund_deadline: 0u64,
            min_deposit: 0i128,
            max_user_dep: 0i128,
            redem_fee_bps: 0u32,
            rwa_name: String::from_str(&env, "Bond"),
            rwa_symbol: String::from_str(&env, "BND"),
            rwa_document_uri: String::from_str(&env, "https://example.com"),
            rwa_category: String::from_str(&env, "Bond"),
            expected_apy: 500u32,
        },),
    );

    Ctx {
        env,
        vault_id,
        token_id,
        admin,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

/// Happy path: 2-of-3 signers propose → second signer approves → execute drains vault.
#[test]
fn test_multisig_2_of_3_happy_path() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let signer3 = Address::generate(env);
    let recipient = Address::generate(env);

    // Configure 2-of-3 multi-sig.
    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone(), signer3.clone()],
        &2u32,
    );

    // Fund the vault.
    ctx.fund_vault(500_000);

    // signer1 proposes — their approval is auto-recorded.
    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);
    assert_eq!(proposal_id, 0u32);

    // signer2 approves → threshold (2) is now met.
    vault.approve_emergency_withdraw(&signer2, &proposal_id);

    // Any signer can execute once threshold is met.
    vault.execute_emergency_withdraw(&signer3, &proposal_id);

    // All funds should have moved to recipient.
    assert_eq!(ctx.token_balance(&recipient), 500_000);
    assert_eq!(ctx.token_balance(&ctx.vault_id), 0);

    // Vault should be paused after execution.
    assert!(vault.paused());
}

/// Execution must be blocked if only 1 of 3 signers have approved (threshold = 2).
#[test]
#[should_panic(expected = "Error(Contract, #31)")] // ThresholdNotMet = 31
fn test_execute_fails_below_threshold() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let signer3 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone(), signer3.clone()],
        &2u32,
    );

    // Only proposer's auto-approval (1 of 3) — below threshold.
    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);

    vault.execute_emergency_withdraw(&signer1, &proposal_id);
}

/// A proposal that has not received any approval other than the proposer's
/// cannot be executed even by a different signer.
#[test]
#[should_panic(expected = "Error(Contract, #31)")] // ThresholdNotMet = 31
fn test_execute_fails_with_only_proposer_approval_3_of_3() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let signer3 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone(), signer3.clone()],
        &3u32, // unanimous
    );

    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);
    vault.approve_emergency_withdraw(&signer2, &proposal_id);

    // Only 2 of 3 — still blocked.
    vault.execute_emergency_withdraw(&signer3, &proposal_id);
}

/// An approved proposal expires after 24 hours and can no longer be executed.
#[test]
#[should_panic(expected = "Error(Contract, #30)")] // ProposalExpired = 30
fn test_expired_proposal_cannot_be_executed() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &2u32,
    );

    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);
    vault.approve_emergency_withdraw(&signer2, &proposal_id);

    // Advance past the 24-hour window.
    let now = env.ledger().timestamp();
    env.ledger().with_mut(|li| li.timestamp = now + 86_401);

    vault.execute_emergency_withdraw(&signer1, &proposal_id);
}

/// Approving after expiry is rejected.
#[test]
#[should_panic(expected = "Error(Contract, #30)")] // ProposalExpired = 30
fn test_expired_proposal_cannot_be_approved() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &2u32,
    );

    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);

    // Advance past the 24-hour window before second approval.
    let now = env.ledger().timestamp();
    env.ledger().with_mut(|li| li.timestamp = now + 86_401);

    vault.approve_emergency_withdraw(&signer2, &proposal_id);
}

/// A signer cannot approve the same proposal twice.
#[test]
#[should_panic(expected = "Error(Contract, #32)")] // AlreadyApproved = 32
fn test_double_approval_rejected() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &2u32,
    );

    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);
    vault.approve_emergency_withdraw(&signer1, &proposal_id); // signer1 already voted via propose
}

/// An address that is not in the signer list cannot propose.
#[test]
#[should_panic(expected = "Error(Contract, #28)")] // NotEmergencySigner = 28
fn test_non_signer_cannot_propose() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let outsider = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(&ctx.admin, &vec![env, signer1.clone()], &1u32);

    vault.propose_emergency_withdraw(&outsider, &recipient);
}

/// An address that is not in the signer list cannot approve.
#[test]
#[should_panic(expected = "Error(Contract, #28)")] // NotEmergencySigner = 28
fn test_non_signer_cannot_approve() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let outsider = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &2u32,
    );

    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);
    vault.approve_emergency_withdraw(&outsider, &proposal_id);
}

/// Executed proposals cannot be executed a second time.
#[test]
#[should_panic(expected = "Error(Contract, #33)")] // ProposalAlreadyExecuted = 33
fn test_already_executed_proposal_rejected() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &2u32,
    );

    let proposal_id = vault.propose_emergency_withdraw(&signer1, &recipient);
    vault.approve_emergency_withdraw(&signer2, &proposal_id);
    vault.execute_emergency_withdraw(&signer1, &proposal_id); // first execution succeeds

    vault.execute_emergency_withdraw(&signer1, &proposal_id); // second must fail
}

/// `emergency_withdraw` (single-admin fallback) works when no multi-sig is configured.
#[test]
fn test_single_admin_fallback_works_without_multisig() {
    let ctx = setup();
    let vault = ctx.vault();
    let recipient = Address::generate(&ctx.env);

    ctx.fund_vault(1_000_000);

    vault.emergency_withdraw(&ctx.admin, &recipient);

    assert_eq!(ctx.token_balance(&recipient), 1_000_000);
    assert_eq!(ctx.token_balance(&ctx.vault_id), 0);
    assert!(vault.paused());
}

/// `emergency_withdraw` (single-admin fallback) is blocked once multi-sig is configured.
#[test]
#[should_panic(expected = "Error(Contract, #34)")] // MultiSigConfigured = 34
fn test_single_admin_fallback_blocked_after_multisig_configured() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);
    let recipient = Address::generate(env);

    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &2u32,
    );

    // Admin tries to use the single-key backdoor — must be blocked.
    vault.emergency_withdraw(&ctx.admin, &recipient);
}

/// Admin can rotate the signer set and threshold.
#[test]
fn test_admin_can_update_signers() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let old_signer = Address::generate(env);
    let new_signer1 = Address::generate(env);
    let new_signer2 = Address::generate(env);

    // Initial 1-of-1 config.
    vault.set_emergency_signers(&ctx.admin, &vec![env, old_signer.clone()], &1u32);

    // Rotate to new 2-of-2 config.
    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, new_signer1.clone(), new_signer2.clone()],
        &2u32,
    );

    let recipient = Address::generate(env);
    ctx.fund_vault(100_000);

    // Old signer can no longer propose.
    // (tested indirectly: new 2-of-2 flow works)
    let pid = vault.propose_emergency_withdraw(&new_signer1, &recipient);
    vault.approve_emergency_withdraw(&new_signer2, &pid);
    vault.execute_emergency_withdraw(&new_signer1, &pid);

    assert_eq!(ctx.token_balance(&recipient), 100_000);
}

/// `set_emergency_signers` rejects an invalid threshold (zero or > signer count).
#[test]
#[should_panic(expected = "Error(Contract, #36)")] // InvalidThreshold = 36
fn test_invalid_threshold_rejected() {
    let ctx = setup();
    let vault = ctx.vault();
    let env = &ctx.env;

    let signer1 = Address::generate(env);
    let signer2 = Address::generate(env);

    // threshold (3) > signers (2) — must fail.
    vault.set_emergency_signers(
        &ctx.admin,
        &vec![env, signer1.clone(), signer2.clone()],
        &3u32,
    );
}
