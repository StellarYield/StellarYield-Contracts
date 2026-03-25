extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
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

    pub fn approve(e: Env, from: Address, spender: Address, amount: i128) {
        let allowance_key = (from, spender);
        e.storage().persistent().set(&allowance_key, &amount);
    }

    pub fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        let allowance_key = (from, spender);
        e.storage().persistent().get(&allowance_key).unwrap_or(0)
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

    pub fn kyc_approve(e: Env, _cooperator: Address, user: Address) {
        e.storage().instance().set(&user, &true);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup helpers
// ─────────────────────────────────────────────────────────────────────────────

fn create_vault_with_lockup(e: &Env, lock_up_period: u64) -> (Address, Address, Address, SingleRWAVaultClient) {
    let admin = Address::generate(e);
    let asset = e.register(MockToken, ());
    let kyc = e.register(MockZkme, ());

    let params = InitParams {
        asset: asset.clone(),
        share_name: String::from_str(e, "Vault Share"),
        share_symbol: String::from_str(e, "vSHARE"),
        share_decimals: 7,
        admin: admin.clone(),
        zkme_verifier: kyc.clone(),
        cooperator: Address::generate(e),
        funding_target: 1000000,
        maturity_date: e.ledger().timestamp() + 1000000,
        min_deposit: 100,
        max_deposit_per_user: 500000,
        early_redemption_fee_bps: 100,
        funding_deadline: e.ledger().timestamp() + 100000,
        lock_up_period,
        rwa_name: String::from_str(e, "Test RWA"),
        rwa_symbol: String::from_str(e, "TRWA"),
        rwa_document_uri: String::from_str(e, "https://example.com/doc"),
        rwa_category: String::from_str(e, "Test"),
        expected_apy: 500,
    };

    let vault_id = e.register(SingleRWAVault, (params,));
    let vault = SingleRWAVaultClient::new(e, &vault_id);

    // Approve KYC for admin
    MockZkmeClient::new(e, &kyc).kyc_approve(&admin, &admin);

    (admin, asset, kyc, vault)
}

fn setup_user_with_deposit(e: &Env, vault: &SingleRWAVaultClient, asset: &Address, kyc: &Address, user: &Address, deposit_amount: i128) {
    // Approve KYC for user
    MockZkmeClient::new(e, &kyc).kyc_approve(user, user);
    
    // Mint assets to user
    MockTokenClient::new(e, &asset).mint(user, &deposit_amount);
    
    // Approve vault to spend user's assets  
    MockTokenClient::new(e, &asset).approve(user, &vault.address, &deposit_amount);
    
    // Deposit assets
    vault.deposit(user, &deposit_amount, user);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock-up period tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_lock_up_period_enforced() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // Verify lock-up remaining time
    let remaining = vault.lock_up_remaining(&user1);
    assert!(remaining > 0);
    assert!(remaining <= lock_up_period);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_transfer_during_lock_up_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // This should panic with SharesLocked error
    vault.transfer(&user1, &user2, &100);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_withdraw_during_lock_up_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // This should panic with SharesLocked error
    vault.withdraw(&user1, &50, &user2, &user1);
}

#[test]
fn test_lock_up_period_expired() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 1; // 1 second
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // Advance time beyond lock-up period
    e.ledger().set_timestamp(e.ledger().timestamp() + lock_up_period + 1);

    // Verify no lock-up remaining time
    let remaining = vault.lock_up_remaining(&user1);
    assert_eq!(remaining, 0);

    // Transfer should succeed after lock-up period
    vault.transfer(&user1, &user2, &100);
    
    // Verify balances
    assert_eq!(vault.balance(&user1), 900);
    assert_eq!(vault.balance(&user2), 100);
}

#[test]
fn test_no_lock_up_period() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 0; // No lock-up period
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // Verify no lock-up remaining time
    let remaining = vault.lock_up_remaining(&user1);
    assert_eq!(remaining, 0);

    // Transfer should succeed immediately
    vault.transfer(&user1, &user2, &100);
    
    // Verify balances
    assert_eq!(vault.balance(&user1), 900);
    assert_eq!(vault.balance(&user2), 100);
}

#[test]
fn test_redeem_at_maturity_bypasses_lock_up() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // Activate vault and advance to maturity
    vault.activate_vault(&admin);
    e.ledger().set_timestamp(e.ledger().timestamp() + 2000000); // Past maturity

    // redeem_at_maturity should succeed even during lock-up period
    vault.redeem_at_maturity(&user1, &500, &user2, &user1);
    
    // Verify user received assets (mock token balance check)
    let token = MockTokenClient::new(&e, &asset);
    assert_eq!(token.balance(&user2), 500);
}

#[test]
fn test_admin_update_lock_up_period() {
    let e = Env::default();
    e.mock_all_auths();

    let initial_lock_up_period = 3600; // 1 hour
    let (admin, asset, kyc, vault) = create_vault_with_lockup(&e, initial_lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // Verify initial lock-up remaining time
    let remaining = vault.lock_up_remaining(&user1);
    assert!(remaining > 0);

    // Admin updates lock-up period for future deposits
    let new_lock_up_period = 7200; // 2 hours
    vault.set_lock_up_period(&admin, &new_lock_up_period);

    // User1's existing deposit should still have original lock-up period
    let remaining_after_update = vault.lock_up_remaining(&user1);
    assert!(remaining_after_update <= initial_lock_up_period);

    // New user deposit should use new lock-up period
    let user3 = Address::generate(&e);
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user3, deposit_amount);
    
    let remaining_new_user = vault.lock_up_remaining(&user3);
    assert!(remaining_new_user > remaining_after_update); // Should have longer lock-up
}

#[test]
fn test_lock_up_remaining_edge_cases() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user = Address::generate(&e);

    // Test user with no deposit
    let remaining = vault.lock_up_remaining(&user);
    assert_eq!(remaining, 0);

    // Setup user with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user, 1000);

    // Test exactly at lock-up expiration
    let deposit_timestamp = e.ledger().timestamp();
    e.ledger().set_timestamp(deposit_timestamp + lock_up_period);
    
    let remaining = vault.lock_up_remaining(&user);
    assert_eq!(remaining, 0);

    // Test just before lock-up expiration
    e.ledger().set_timestamp(deposit_timestamp + lock_up_period - 1);
    
    let remaining = vault.lock_up_remaining(&user);
    assert_eq!(remaining, 1);
}

#[test]
fn test_multiple_users_different_lock_up_times() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);

    // User1 deposits now
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, 1000);
    let user1_deposit_time = e.ledger().timestamp();

    // Advance time and user2 deposits later
    e.ledger().set_timestamp(user1_deposit_time + 1800); // 30 minutes later
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user2, 1000);

    // User1 should have less remaining lock-up time than user2
    let remaining_user1 = vault.lock_up_remaining(&user1);
    let remaining_user2 = vault.lock_up_remaining(&user2);
    
    assert!(remaining_user1 < remaining_user2);
    assert_eq!(remaining_user2 - remaining_user1, 1800); // 30 minutes difference
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_redeem_during_lock_up_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // This should panic with SharesLocked error
    vault.redeem(&user1, &50, &user2, &user1);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_request_early_redemption_during_lock_up_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // This should panic with SharesLocked error
    vault.request_early_redemption(&user1, &50);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_transfer_from_during_lock_up_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let lock_up_period = 3600; // 1 hour
    let (_admin, asset, kyc, vault) = create_vault_with_lockup(&e, lock_up_period);
    
    let user1 = Address::generate(&e);
    let user2 = Address::generate(&e);
    let deposit_amount = 1000i128;

    // Setup user1 with deposit
    setup_user_with_deposit(&e, &vault, &asset, &kyc, &user1, deposit_amount);

    // First approve allowance to self
    vault.transfer(&user1, &user1, &100);

    // This should panic with SharesLocked error
    vault.transfer_from(&user1, &user1, &user2, &50);
}
