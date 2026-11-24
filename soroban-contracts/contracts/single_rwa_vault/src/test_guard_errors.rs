//! Tests for error-guard and view coverage:
//! - `NotInEmergency` / `AlreadyClaimedEmergency` on `emergency_claim` (#1359)
//! - `pending_emergency_claim` across emergency withdraw / recovery / claim (#1353)
//! - `InvalidEpochRange` on `get_epoch_range` (#1358)
//! - `InvalidRedemptionRequest` / settled-ID guards on early-redemption entry
//!   points (#1357)

extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String as SorobanString};

use crate::tests::{fund_user, make_vault, MockTokenClient};
use crate::types::RedemptionStatus;
use crate::SingleRWAVaultClient;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Deploy a vault (funding_target = 0), fund `user`, and activate it.
fn setup_active_vault(env: &Env) -> (Address, Address, Address, Address, Address, i128) {
    let (vault_id, token_id, zkme_id, admin) = make_vault(env);
    let vault = SingleRWAVaultClient::new(env, &vault_id);
    let user = Address::generate(env);
    let shares = fund_user(env, &vault_id, &token_id, &zkme_id, &user, 10_000_000);
    assert!(shares > 0);
    vault.activate_vault(&admin);
    (vault_id, token_id, zkme_id, admin, user, shares)
}

fn panic_message(err: &(dyn std::any::Any + Send)) -> std::string::String {
    if let Some(s) = err.downcast_ref::<std::string::String>() {
        s.clone()
    } else if let Some(s) = err.downcast_ref::<&'static str>() {
        std::string::String::from(*s)
    } else {
        std::string::String::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// #1359 — emergency_claim guards: NotInEmergency / AlreadyClaimedEmergency
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_emergency_claim_reverts_when_not_in_emergency() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, _zkme_id, _admin, user, shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    // Vault is Active, not Emergency.
    let tokens_before = token.balance(&user);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.emergency_claim(&user);
    }));
    let err = result.expect_err("emergency_claim must revert outside Emergency state");
    assert!(
        panic_message(&*err).contains("Error(Contract, #29)"),
        "expected NotInEmergency (#29)"
    );

    // Balances unchanged.
    assert_eq!(token.balance(&user), tokens_before);
    assert_eq!(vault.balance(&user), shares);
}

#[test]
fn test_emergency_claim_second_claim_reverts_and_preserves_balances() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin, user, _shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    vault.emergency_enable_pro_rata(&admin);

    // First claim succeeds.
    let claimed = vault.emergency_claim(&user);
    assert!(claimed > 0);

    // Second claim reverts with AlreadyClaimedEmergency and changes nothing.
    let tokens_before = token.balance(&user);
    let shares_before = vault.balance(&user);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.emergency_claim(&user);
    }));
    let err = result.expect_err("second emergency_claim must revert");
    assert!(
        panic_message(&*err).contains("Error(Contract, #30)"),
        "expected AlreadyClaimedEmergency (#30)"
    );

    assert_eq!(token.balance(&user), tokens_before);
    assert_eq!(vault.balance(&user), shares_before);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1353 — pending_emergency_claim before / after emergency_withdraw / after claim
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_pending_emergency_claim_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    // Two equal depositors so each holds half of total supply.
    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);
    let deposit = 10_000_000i128;
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user_a, deposit);
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user_b, deposit);

    // Before any emergency action the vault is not in Emergency state.
    assert_eq!(vault.pending_emergency_claim(&user_a), 0);

    // emergency_withdraw drains the vault to the recovery address.
    let recovery = Address::generate(&env);
    vault.pause(&admin, &SorobanString::from_str(&env, "emergency"));
    vault.emergency_withdraw(&admin, &recovery);
    assert_eq!(token.balance(&vault_id), 0);
    assert_eq!(token.balance(&recovery), deposit * 2);

    // Recovered assets are returned to the vault and pro-rata mode is enabled.
    let recovered = 4_000_000i128;
    token.mint(&vault_id, &recovered);
    vault.emergency_enable_pro_rata(&admin);

    // Each holder's pending amount equals their pro-rata share of recovered assets.
    let supply = vault.total_supply();
    let shares_a = vault.balance(&user_a);
    let expected_a = recovered * shares_a / supply;
    let expected_b = recovered * vault.balance(&user_b) / supply;
    assert_eq!(vault.pending_emergency_claim(&user_a), expected_a);
    assert_eq!(vault.pending_emergency_claim(&user_b), expected_b);
    assert!(expected_a > 0);

    // After claiming, the pending amount drops to zero.
    let claimed = vault.emergency_claim(&user_a);
    assert_eq!(claimed, expected_a);
    assert_eq!(vault.pending_emergency_claim(&user_a), 0);
    // The other holder's pending amount is untouched.
    assert_eq!(vault.pending_emergency_claim(&user_b), expected_b);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1358 — get_epoch_range InvalidEpochRange guards
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_get_epoch_range_start_greater_than_end_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    vault.get_epoch_range(&3u32, &2u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_get_epoch_range_zero_start_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    vault.get_epoch_range(&0u32, &5u32);
}

#[test]
fn test_get_epoch_range_clips_to_current_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin, _user, _shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    // Distribute two epochs of yield.
    for amount in [1_000i128, 2_000i128] {
        token.mint(&admin, &amount);
        vault.distribute_yield(&admin, &amount);
    }

    // Range extending past the current epoch is clipped, not an error.
    let clipped = vault.get_epoch_range(&1u32, &10u32);
    assert_eq!(clipped.len(), 2);

    // A range starting after the current epoch returns an empty result.
    let empty = vault.get_epoch_range(&5u32, &10u32);
    assert_eq!(empty.len(), 0);
}

#[test]
fn test_get_epoch_range_valid_range_returns_full_length() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin, _user, _shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    for amount in [1_000i128, 2_000i128, 3_000i128] {
        token.mint(&admin, &amount);
        vault.distribute_yield(&admin, &amount);
    }

    let range = vault.get_epoch_range(&1u32, &3u32);
    assert_eq!(range.len(), 3);
    assert_eq!(range.get(0).unwrap().epoch, 1);
    assert_eq!(range.get(2).unwrap().epoch, 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1357 — early-redemption entry points reject unknown / settled request IDs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn test_process_early_redemption_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin, _user, _shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    vault.process_early_redemption(&admin, &999u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn test_cancel_early_redemption_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin, user, _shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    vault.cancel_early_redemption(&user, &999u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn test_reject_early_redemption_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin, _user, _shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let reason = SorobanString::from_str(&env, "unknown request");
    vault.reject_early_redemption(&admin, &999u32, &reason);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_process_early_redemption_settled_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin, user, shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    let request_id = vault.request_early_redemption(&user, &(shares / 2));
    vault.process_early_redemption(&admin, &request_id);
    // Processing an already-settled request must revert.
    vault.process_early_redemption(&admin, &request_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_cancel_early_redemption_settled_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin, user, shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    let request_id = vault.request_early_redemption(&user, &(shares / 2));
    vault.process_early_redemption(&admin, &request_id);
    // Cancelling an already-processed request must revert.
    vault.cancel_early_redemption(&user, &request_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_reject_early_redemption_settled_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin, user, shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    let request_id = vault.request_early_redemption(&user, &(shares / 2));
    vault.cancel_early_redemption(&user, &request_id);
    // Rejecting an already-settled (cancelled) request must revert.
    let reason = SorobanString::from_str(&env, "too late");
    vault.reject_early_redemption(&admin, &request_id, &reason);
}

#[test]
fn test_redemption_request_status_transitions_for_settled_ids() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin, user, shares) = setup_active_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // A processed request ends in Approved status.
    let approved_id = vault.request_early_redemption(&user, &(shares / 4));
    vault.process_early_redemption(&admin, &approved_id);
    assert_eq!(
        vault.redemption_request(&approved_id).status,
        RedemptionStatus::Approved
    );

    // A cancelled request ends in Rejected status.
    let cancelled_id = vault.request_early_redemption(&user, &(shares / 4));
    vault.cancel_early_redemption(&user, &cancelled_id);
    assert_eq!(
        vault.redemption_request(&cancelled_id).status,
        RedemptionStatus::Rejected
    );

    // A rejected request ends in Rejected status.
    let rejected_id = vault.request_early_redemption(&user, &(shares / 4));
    let reason = SorobanString::from_str(&env, "denied");
    vault.reject_early_redemption(&admin, &rejected_id, &reason);
    assert_eq!(
        vault.redemption_request(&rejected_id).status,
        RedemptionStatus::Rejected
    );
}
