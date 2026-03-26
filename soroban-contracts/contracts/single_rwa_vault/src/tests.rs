extern crate std;

use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Env, String};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token
// Only `balance` and `transfer` are needed by the vault.
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct MockToken;

#[contractimpl]
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

    /// Test-only mint; no auth required.
    pub fn mint(e: Env, to: Address, amount: i128) {
        let bal: i128 = e.storage().persistent().get(&to).unwrap_or(0);
        e.storage().persistent().set(&to, &(bal + amount));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock zkMe verifier
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct MockZkme;

#[contractimpl]
impl MockZkme {
    /// Returns true when the user has been granted approval via `approve_user`.
    pub fn has_approved(e: Env, _cooperator: Address, user: Address) -> bool {
        e.storage().instance().get(&user).unwrap_or(false)
    }

    /// Test helper — grant KYC approval to a user.
    pub fn approve_user(e: Env, user: Address) {
        e.storage().instance().set(&user, &true);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

pub fn make_vault(env: &Env) -> (Address, Address, Address, Address) {
    let admin = Address::generate(env);
    let cooperator = Address::generate(env);

    let token_id = env.register(MockToken, ());
    let zkme_id = env.register(MockZkme, ());

    let vault_id = env.register(
        SingleRWAVault,
        (InitParams {
            asset: token_id.clone(),
            share_name: String::from_str(env, "Test Share"),
            share_symbol: String::from_str(env, "TS"),
            share_decimals: 6u32,
            admin: admin.clone(),
            zkme_verifier: zkme_id.clone(),
            cooperator: cooperator.clone(),
            funding_target: 0i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 9_999_999_999u64,
            min_deposit: 0i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 200u32,
            lock_up_period: 0u64,
            rwa_name: String::from_str(env, "Bond A"),
            rwa_symbol: String::from_str(env, "BOND"),
            rwa_document_uri: String::from_str(env, "https://example.com"),
            rwa_category: String::from_str(env, "Bond"),
            expected_apy: 500u32,
        },),
    );

    (vault_id, token_id, zkme_id, admin)
}

/// Approve `user` in zkMe, mint tokens to them, and deposit into the vault.
/// Returns the number of vault shares minted.
pub fn fund_user(
    env: &Env,
    vault_id: &Address,
    token_id: &Address,
    zkme_id: &Address,
    user: &Address,
    amount: i128,
) -> i128 {
    MockZkmeClient::new(env, zkme_id).approve_user(user);
    MockTokenClient::new(env, token_id).mint(user, &amount);
    SingleRWAVaultClient::new(env, vault_id).deposit(user, &amount, user)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — transfer
// ─────────────────────────────────────────────────────────────────────────────

/// Transfer to a KYC-verified recipient must succeed and update balances.
#[test]
fn test_transfer_to_kyc_verified_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &from, 1_000_000);
    // Approve the recipient in zkMe
    MockZkmeClient::new(&env, &zkme_id).approve_user(&to);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let transfer_amount = shares / 2;
    vault.transfer(&from, &to, &transfer_amount);

    assert_eq!(vault.balance(&from), shares - transfer_amount);
    assert_eq!(vault.balance(&to), transfer_amount);
}

/// Transfer to a non-KYC'd recipient must be rejected with NotKYCVerified.
#[test]
#[should_panic]
fn test_transfer_to_non_kyc_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env); // NOT approved in zkMe

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &from, 1_000_000);

    // Must panic — `to` is not KYC-verified.
    SingleRWAVaultClient::new(&env, &vault_id).transfer(&from, &to, &shares);
}

/// When the admin disables the KYC flag, transfers to unapproved recipients are allowed.
#[test]
fn test_transfer_kyc_flag_disabled_allows_unverified_to() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env); // NOT approved in zkMe

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &from, 1_000_000);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Admin disables the transfer KYC requirement.
    vault.set_transfer_requires_kyc(&admin, &false);
    assert!(!vault.transfer_requires_kyc());

    // Transfer to unapproved `to` must now succeed.
    vault.transfer(&from, &to, &shares);
    assert_eq!(vault.balance(&from), 0);
    assert_eq!(vault.balance(&to), shares);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — transfer_from
// ─────────────────────────────────────────────────────────────────────────────

/// transfer_from to a KYC-verified recipient succeeds.
#[test]
fn test_transfer_from_to_kyc_verified_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &owner, 1_000_000);
    MockZkmeClient::new(&env, &zkme_id).approve_user(&to);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let transfer_amount = shares / 2;
    vault.approve(&owner, &spender, &transfer_amount, &999_999u32);
    vault.transfer_from(&spender, &owner, &to, &transfer_amount);

    assert_eq!(vault.balance(&owner), shares - transfer_amount);
    assert_eq!(vault.balance(&to), transfer_amount);
}

/// transfer_from to a non-KYC'd recipient must be rejected.
#[test]
#[should_panic]
fn test_transfer_from_to_non_kyc_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env); // NOT approved in zkMe

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &owner, 1_000_000);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    vault.approve(&owner, &spender, &shares, &999_999u32);

    // Must panic — `to` is not KYC-verified.
    vault.transfer_from(&spender, &owner, &to, &shares);
}
