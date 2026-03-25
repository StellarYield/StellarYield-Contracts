extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, String, IntoVal,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token
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
// Mock zkMe verifier
// ─────────────────────────────────────────────────────────────────────────────

#[soroban_sdk::contract]
pub struct MockZkme;

#[soroban_sdk::contractimpl]
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
            funding_target: 1_000_000i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 0u64,
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Role Management
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_operator_grants_access() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let operator = Address::generate(&e);

    assert!(!vault.is_operator(&operator));
    vault.set_operator(&admin, &operator, &true);
    assert!(vault.is_operator(&operator));
}

#[test]
fn test_set_operator_revokes_access() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let operator = Address::generate(&e);

    vault.set_operator(&admin, &operator, &true);
    assert!(vault.is_operator(&operator));
    vault.set_operator(&admin, &operator, &false);
    assert!(!vault.is_operator(&operator));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_set_operator_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, _) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let non_admin = Address::generate(&e);
    let operator = Address::generate(&e);

    vault.set_operator(&non_admin, &operator, &true);
}

#[test]
fn test_transfer_admin() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, old_admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let new_admin = Address::generate(&e);

    // Initial check
    assert_eq!(vault.admin(), old_admin);

    // Transfer
    vault.transfer_admin(&old_admin, &new_admin);
    assert_eq!(vault.admin(), new_admin);

    // New admin can perform admin actions (e.g., set operator)
    let op = Address::generate(&e);
    vault.set_operator(&new_admin, &op, &true);
    assert!(vault.is_operator(&op));

    // Old admin cannot (this should panic if we tested it, but let's just verify the transfer)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Pause / Unpause
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // Error::VaultPaused = 11
fn test_pause_blocks_deposits() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    // Grant operator to admin so they can pause
    vault.set_operator(&admin, &admin, &true);
    vault.pause(&admin, &String::from_str(&e, "Maintenance"));
    assert!(vault.paused());

    // Try to deposit
    MockTokenClient::new(&e, &token_id).mint(&user, &1000);
    vault.deposit(&user, &1000, &user);
}

#[test]
fn test_unpause_resumes_operations() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    vault.set_operator(&admin, &admin, &true);
    vault.pause(&admin, &String::from_str(&e, "Maintenance"));
    assert!(vault.paused());

    vault.unpause(&admin);
    assert!(!vault.paused());

    // Deposit should work now
    MockZkmeClient::new(&e, &zkme_id).approve_user(&user);
    MockTokenClient::new(&e, &token_id).mint(&user, &1000);
    vault.deposit(&user, &1000, &user);
    assert_eq!(vault.balance(&user), 1000);
}

#[test]
fn test_pause_emits_event_with_reason() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    vault.set_operator(&admin, &admin, &true);
    let reason = String::from_str(&e, "Critical failure");
    vault.pause(&admin, &reason);

    let last_event = e.events().all().last().unwrap();
    // emit_emergency_action(e, true, reason): (symbol!("emergency"),), (true, reason)
    let (_, topics, data) = last_event;
    let topic: soroban_sdk::Symbol = topics.get(0).unwrap().into_val(&e);
    assert_eq!(topic, soroban_sdk::symbol_short!("emergency"));
    
    let (paused, event_reason): (bool, String) = data.into_val(&e);
    assert!(paused);
    assert_eq!(event_reason, reason);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Emergency
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_emergency_withdraw_drains_vault() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let recipient = Address::generate(&e);

    // Add some funds to the vault
    token.mint(&vault_id, &5000);
    assert_eq!(token.balance(&vault_id), 5000);

    vault.emergency_withdraw(&admin, &recipient);

    // Vault should be empty
    assert_eq!(token.balance(&vault_id), 0);
    // Recipient should have funds
    assert_eq!(token.balance(&recipient), 5000);
    // Vault should be paused
    assert!(vault.paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_emergency_withdraw_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let operator = Address::generate(&e);
    let recipient = Address::generate(&e);

    vault.set_operator(&admin, &operator, &true);
    
    // Operator (non-admin) tries to call emergency withdraw
    vault.emergency_withdraw(&operator, &recipient);
}

#[test]
fn test_emergency_withdraw_zero_balance_no_transfer() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let recipient = Address::generate(&e);

    assert_eq!(token.balance(&vault_id), 0);

    vault.emergency_withdraw(&admin, &recipient);

    assert_eq!(token.balance(&recipient), 0);
    assert!(vault.paused());
}
