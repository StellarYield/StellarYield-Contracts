extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token
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
    pub fn has_approved(e: Env, _cooperator: Address, user: Address) -> bool {
        e.storage().instance().get(&user).unwrap_or(false)
    }

    pub fn approve_user(e: Env, user: Address) {
        e.storage().instance().set(&user, &true);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Create a vault in Funding state with funding_target = 0 (auto-met).
fn make_vault(env: &Env) -> (Address, Address, Address, Address) {
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
            funding_deadline: 0u64,
            min_deposit: 0i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 200u32,
            operator_fee_bps: 0u32,
            rwa_name: String::from_str(env, "Bond A"),
            rwa_symbol: String::from_str(env, "BOND"),
            rwa_document_uri: String::from_str(env, "https://example.com"),
            rwa_category: String::from_str(env, "Bond"),
            expected_apy: 500u32,
            timelock_delay: 172800u64,
            yield_vesting_period: 0u64,
        },),
    );

    (vault_id, token_id, zkme_id, admin)
}

/// Approve `user` in zkMe, mint tokens to them, and deposit into the vault.
fn fund_user(
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

/// Transition the vault Funding → Active.
fn activate(env: &Env, vault_id: &Address, admin: &Address) {
    SingleRWAVaultClient::new(env, vault_id).activate_vault(admin);
}

/// Transition the vault Active → Matured.
fn mature(env: &Env, vault_id: &Address, admin: &Address) {
    let vault = SingleRWAVaultClient::new(env, vault_id);
    let maturity = vault.maturity_date();
    env.ledger().with_mut(|li| {
        li.timestamp = maturity + 1;
    });
    vault.mature_vault(admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// withdraw — state guard tests
// ─────────────────────────────────────────────────────────────────────────────

/// withdraw during Funding state must panic with Error::InvalidVaultState.
#[test]
#[should_panic]
fn test_withdraw_during_funding_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let user = Address::generate(&env);

    // Deposit is allowed during Funding, so we have shares.
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Vault is still in Funding — must panic.
    vault.withdraw(&user, &shares, &user, &user);
}

/// withdraw during Active state succeeds.
#[test]
fn test_withdraw_during_active_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let user_balance_before = token.balance(&user);
    let withdraw_amount = 500_000i128;
    vault.withdraw(&user, &withdraw_amount, &user, &user);

    let user_balance_after = token.balance(&user);
    assert_eq!(user_balance_after, user_balance_before + withdraw_amount);
}

/// withdraw during Matured state succeeds.
#[test]
fn test_withdraw_during_matured_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);
    mature(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let user_balance_before = token.balance(&user);
    let withdraw_amount = 500_000i128;
    vault.withdraw(&user, &withdraw_amount, &user, &user);

    let user_balance_after = token.balance(&user);
    assert_eq!(user_balance_after, user_balance_before + withdraw_amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// redeem — state guard tests
// ─────────────────────────────────────────────────────────────────────────────

/// redeem during Funding state must panic with Error::InvalidVaultState.
#[test]
#[should_panic]
fn test_redeem_during_funding_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let user = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Vault is still in Funding — must panic.
    vault.redeem(&user, &shares, &user, &user);
}

/// redeem during Active state succeeds.
#[test]
fn test_redeem_during_active_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let user_balance_before = token.balance(&user);
    vault.redeem(&user, &shares, &user, &user);

    let user_balance_after = token.balance(&user);
    assert!(user_balance_after > user_balance_before);
    assert_eq!(vault.balance(&user), 0);
}

/// redeem during Matured state succeeds.
#[test]
fn test_redeem_during_matured_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);
    mature(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let user_balance_before = token.balance(&user);
    vault.redeem(&user, &shares, &user, &user);

    let user_balance_after = token.balance(&user);
    assert!(user_balance_after > user_balance_before);
    assert_eq!(vault.balance(&user), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// claim_yield — state guard tests
// ─────────────────────────────────────────────────────────────────────────────

/// claim_yield during Funding state must panic with Error::InvalidVaultState.
#[test]
#[should_panic]
fn test_claim_yield_during_funding_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let user = Address::generate(&env);

    // Deposit during Funding so user has shares.
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Vault is still in Funding -- must panic.
    vault.claim_yield(&user);
}

/// claim_yield during Active state succeeds (when yield has been distributed).
#[test]
fn test_claim_yield_during_active_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    // Distribute yield so there is something to claim.
    token.mint(&admin, &500_000);
    vault.distribute_yield(&admin, &500_000);

    let pending = vault.pending_yield(&user);
    assert!(pending > 0);

    let claimed = vault.claim_yield(&user);
    assert_eq!(claimed, pending);
}

/// claim_yield_for_epoch during Funding state must panic.
#[test]
#[should_panic]
fn test_claim_yield_for_epoch_during_funding_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let user = Address::generate(&env);

    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Vault is still in Funding -- must panic.
    vault.claim_yield_for_epoch(&user, &1);
}

// ─────────────────────────────────────────────────────────────────────────────
// process_early_redemption — state guard tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Contract, #5)")] // InvalidVaultState
fn test_process_early_redemption_during_funding_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // Vault still in Funding.
    vault.process_early_redemption(&admin, &1u32);
}

#[test]
fn test_process_early_redemption_during_active_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let request_id = vault.request_early_redemption(&user, &shares);

    // Vault in Active - should succeed.
    vault.process_early_redemption(&admin, &request_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #5)")] // InvalidVaultState
fn test_process_early_redemption_during_matured_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let request_id = vault.request_early_redemption(&user, &shares);

    let maturity = vault.maturity_date();
    env.ledger().set_timestamp(maturity + 1);
    vault.mature_vault(&admin);

    // Vault in Matured.
    vault.process_early_redemption(&admin, &request_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #5)")] // InvalidVaultState
fn test_process_early_redemption_during_closed_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    // Fund user and activate vault.
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // Redeem all shares so total_supply drops to 0 — required for close_vault.
    crate::test_helpers::MockZkmeClient::new(&env, &zkme_id).approve_user(&user);
    vault.redeem(&user, &shares, &user, &user);

    // Advance time past maturity and transition to Matured then Closed.
    let maturity = vault.maturity_date();
    env.ledger().set_timestamp(maturity + 1);
    vault.mature_vault(&admin);
    vault.close_vault(&admin);

    // Vault is now Closed. process_early_redemption must panic with InvalidVaultState (#5).
    vault.process_early_redemption(&admin, &1u32);
}
