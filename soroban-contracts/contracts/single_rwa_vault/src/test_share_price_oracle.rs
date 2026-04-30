extern crate std;

use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Env, String};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token + zkMe verifier (auto-approve)
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

#[contract]
pub struct MockZkme;

#[contractimpl]
impl MockZkme {
    pub fn has_approved(_e: Env, _cooperator: Address, _user: Address) -> bool {
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (share_decimals = 6, so par price = 1_000_000)
// ─────────────────────────────────────────────────────────────────────────────

const PAR: i128 = 1_000_000; // 10^6

fn make_vault(env: &Env) -> (Address, Address, Address) {
    let admin = Address::generate(env);
    let cooperator = Address::generate(env);
    let token_id = env.register(MockToken, ());
    let zkme_id = env.register(MockZkme, ());
    let vault_id = env.register(
        SingleRWAVault,
        (InitParams {
            asset: token_id.clone(),
            share_name: String::from_str(env, "Oracle Share"),
            share_symbol: String::from_str(env, "OS"),
            share_decimals: 6u32,
            admin: admin.clone(),
            zkme_verifier: zkme_id.clone(),
            cooperator: cooperator.clone(),
            funding_target: 0i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 0u64,
            min_deposit: 0i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 0u32,
            operator_fee_bps: 0u32,
            rwa_name: String::from_str(env, "Oracle Bond"),
            rwa_symbol: String::from_str(env, "BOND"),
            rwa_document_uri: String::from_str(env, "https://example.com"),
            rwa_category: String::from_str(env, "Bond"),
            expected_apy: 500u32,
            timelock_delay: 172800u64,
            yield_vesting_period: 0u64,
        },),
    );
    (vault_id, token_id, admin)
}

fn fund(env: &Env, vault_id: &Address, token_id: &Address, who: &Address, amount: i128) {
    MockTokenClient::new(env, token_id).mint(who, &amount);
    SingleRWAVaultClient::new(env, vault_id).deposit(who, &amount, who);
}

fn distribute(env: &Env, vault_id: &Address, token_id: &Address, admin: &Address, amount: i128) {
    MockTokenClient::new(env, token_id).mint(admin, &amount);
    SingleRWAVaultClient::new(env, vault_id).distribute_yield(admin, &amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Live views — share_price / nav_per_share / exchange_rate
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_share_price_returns_par_when_supply_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _t, _a) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    assert_eq!(vault.share_price(), PAR);
    assert_eq!(vault.nav_per_share(), PAR);
    assert_eq!(vault.exchange_rate(), (0, 0));
}

#[test]
fn test_share_price_par_after_first_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, _admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let user = Address::generate(&env);

    fund(&env, &vault_id, &token_id, &user, 1_000_000);

    // Initial 1:1 deposit → price stays at par (10^decimals).
    assert_eq!(vault.share_price(), PAR);
    assert_eq!(vault.exchange_rate(), (1_000_000, 1_000_000));
}

#[test]
fn test_share_price_increases_after_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let user = Address::generate(&env);

    fund(&env, &vault_id, &token_id, &user, 1_000_000);
    vault.activate_vault(&admin);

    let before = vault.share_price();
    distribute(&env, &vault_id, &token_id, &admin, 500_000);
    let after = vault.share_price();

    // total_assets = 1_500_000; total_supply = 1_000_000.
    // price = 1_500_000 * 10^6 / 1_000_000 = 1_500_000.
    assert!(after > before);
    assert_eq!(after, 1_500_000);

    // exchange_rate exposes the raw pair.
    assert_eq!(vault.exchange_rate(), (1_500_000, 1_000_000));
}

#[test]
fn test_share_price_with_precision_scales() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let user = Address::generate(&env);

    fund(&env, &vault_id, &token_id, &user, 1_000_000);
    vault.activate_vault(&admin);
    distribute(&env, &vault_id, &token_id, &admin, 500_000);

    // Same 1.5x ratio at different precisions.
    assert_eq!(vault.share_price_with_precision(&0u32), 1);
    assert_eq!(vault.share_price_with_precision(&2u32), 150);
    assert_eq!(vault.share_price_with_precision(&6u32), 1_500_000);
    assert_eq!(vault.share_price_with_precision(&8u32), 150_000_000);

    // precision is capped at 18 — 100 should be clamped to 18.
    let cap = vault.share_price_with_precision(&100u32);
    let p18 = vault.share_price_with_precision(&18u32);
    assert_eq!(cap, p18);
}

#[test]
fn test_share_price_with_precision_par_when_supply_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _t, _a) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    assert_eq!(vault.share_price_with_precision(&0u32), 1);
    assert_eq!(vault.share_price_with_precision(&6u32), 1_000_000);
    assert_eq!(vault.share_price_with_precision(&18u32), 10i128.pow(18));
}

// ─────────────────────────────────────────────────────────────────────────────
// price_per_share_history — uses the snapshotted (assets, supply) pair
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_price_per_share_history_records_each_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let user = Address::generate(&env);

    fund(&env, &vault_id, &token_id, &user, 1_000_000);
    vault.activate_vault(&admin);

    // Epoch 1: +500k yield → assets = 1.5M, supply = 1M, price = 1.5x par.
    distribute(&env, &vault_id, &token_id, &admin, 500_000);
    // Epoch 2: +500k yield → assets = 2M, supply = 1M, price = 2x par.
    distribute(&env, &vault_id, &token_id, &admin, 500_000);

    assert_eq!(vault.price_per_share_history(&1u32), 1_500_000);
    assert_eq!(vault.price_per_share_history(&2u32), 2_000_000);
}

#[test]
fn test_price_per_share_history_zero_for_unrecorded_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _t, _a) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // No distributions yet — any historical query returns 0.
    assert_eq!(vault.price_per_share_history(&0u32), 0);
    assert_eq!(vault.price_per_share_history(&1u32), 0);
    assert_eq!(vault.price_per_share_history(&999u32), 0);
}

#[test]
fn test_price_per_share_history_unaffected_by_later_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let user = Address::generate(&env);

    fund(&env, &vault_id, &token_id, &user, 1_000_000);
    vault.activate_vault(&admin);

    distribute(&env, &vault_id, &token_id, &admin, 250_000);
    let epoch1_price = vault.price_per_share_history(&1u32);

    // A later yield distribution must not change historical epoch prices.
    distribute(&env, &vault_id, &token_id, &admin, 1_000_000);
    distribute(&env, &vault_id, &token_id, &admin, 1_000_000);

    assert_eq!(vault.price_per_share_history(&1u32), epoch1_price);
}
