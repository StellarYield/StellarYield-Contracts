//! ERC-4626 rounding direction and zero-output guards (`preview_*`, `max_mint`).

extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::storage::{put_total_deposited, put_total_supply};
use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

fn default_params(env: &Env, admin: &Address, asset: &Address) -> InitParams {
    InitParams {
        asset: asset.clone(),
        share_name: String::from_str(env, "Vault Share"),
        share_symbol: String::from_str(env, "VS"),
        share_decimals: 7,
        admin: admin.clone(),
        zkme_verifier: admin.clone(),
        cooperator: admin.clone(),
        funding_target: 10_000_000_000_000_i128,
        maturity_date: 9_999_999_999_u64,
        min_deposit: 1_i128,
        max_deposit_per_user: 0_i128,
        early_redemption_fee_bps: 100_u32,
        funding_deadline: 0_u64,
        rwa_name: String::from_str(env, "Test RWA"),
        rwa_symbol: String::from_str(env, "TRWA"),
        rwa_document_uri: String::from_str(env, "https://test.com"),
        rwa_category: String::from_str(env, "Real Estate"),
        expected_apy: 500_u32,
        timelock_delay: 172800u64,
        yield_vesting_period: 0u64,
    }
}

fn params_with_user_cap(env: &Env, admin: &Address, asset: &Address, cap: i128) -> InitParams {
    let mut p = default_params(env, admin, asset);
    p.max_deposit_per_user = cap;
    p
}

/// Returns `(env, vault_id)` with KYC bypass (zkme verifier = vault).
fn setup_preview_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let asset_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let vault_id = env.register(SingleRWAVault, (default_params(&env, &admin, &asset_id),));
    SingleRWAVaultClient::new(&env, &vault_id).set_zkme_verifier(&admin, &vault_id);

    (env, vault_id)
}

fn setup_preview_env_with_cap(cap: i128) -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let asset_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let vault_id = env.register(
        SingleRWAVault,
        (params_with_user_cap(&env, &admin, &asset_id, cap),),
    );
    SingleRWAVaultClient::new(&env, &vault_id).set_zkme_verifier(&admin, &vault_id);

    (env, vault_id)
}

fn seed_price(env: &Env, vault_id: &Address, total_assets: i128, total_shares: i128) {
    env.as_contract(vault_id, || {
        put_total_deposited(env, total_assets);
        put_total_supply(env, total_shares);
    });
}

/// Matrix: share price scenarios (supply / totalAssets interpret as shares vs assets scale).
#[test]
fn test_erc4626_preview_rounding_matrix() {
    let (env, vault_id) = setup_preview_env();
    let v = SingleRWAVaultClient::new(&env, &vault_id);

    // 1 — 1:1 price (100 shares, 100 assets): deposit floor
    seed_price(&env, &vault_id, 100, 100);
    assert_eq!(v.preview_deposit(&50), 50);

    // 2 — 2 assets per share (supply 100, ta 200): deposit floor
    seed_price(&env, &vault_id, 200, 100);
    assert_eq!(v.preview_deposit(&100), 50);

    // 3 — 0.5 assets per share (supply 200, ta 100): deposit floor
    seed_price(&env, &vault_id, 100, 200);
    assert_eq!(v.preview_deposit(&100), 200);

    // 4 — 3:7 style (ta=3, supply=7): deposit floor(2*7/3)=4
    seed_price(&env, &vault_id, 3, 7);
    assert_eq!(v.preview_deposit(&2), 4);

    // 5 — mint ceil: supply 100, ta 200, mint 50 shares → ceil(50*200/100)=100
    seed_price(&env, &vault_id, 200, 100);
    assert_eq!(v.preview_mint(&50), 100);

    // 6 — mint ceil with remainder: supply 3, ta 10, 2 shares → ceil(2*10/3)=7
    seed_price(&env, &vault_id, 10, 3);
    assert_eq!(v.preview_mint(&2), 7);

    // 7 — withdraw ceil: 40 shares / 80 assets → withdraw 20 assets → ceil(20*40/80)=10
    seed_price(&env, &vault_id, 80, 40);
    assert_eq!(v.preview_withdraw(&20), 10);

    // 8 — withdraw ceil edge: supply 100, ta 300, 1 asset → ceil(1*100/300)=1
    seed_price(&env, &vault_id, 300, 100);
    assert_eq!(v.preview_withdraw(&1), 1);

    // 9 — redeem floor: 40 shares, 60 assets → 40*60/40=60
    seed_price(&env, &vault_id, 60, 40);
    assert_eq!(v.preview_redeem(&40), 60);

    // 10 — redeem floor rounds down: 7 shares, 10 assets, redeem 3 → floor(3*10/7)=4
    seed_price(&env, &vault_id, 10, 7);
    assert_eq!(v.preview_redeem(&3), 4);

    // 11 — high NAV (1 share, many assets): deposit 1_000_000 assets → 1 share
    seed_price(&env, &vault_id, 1_000_000, 1);
    assert_eq!(v.preview_deposit(&1_000_000), 1);

    // 12 — many shares per asset: supply 1_000_000, ta 1, deposit 1 → floor(1M/1)=1_000_000 shares
    seed_price(&env, &vault_id, 1, 1_000_000);
    assert_eq!(v.preview_deposit(&1), 1_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_preview_deposit_panics_when_assets_round_to_zero_shares() {
    let (env, vault_id) = setup_preview_env();
    let v = SingleRWAVaultClient::new(&env, &vault_id);
    // floor(500 * 100 / 100_000) = floor(0.5) = 0
    seed_price(&env, &vault_id, 100_000, 100);
    let _ = v.preview_deposit(&500);
}

#[test]
#[should_panic(expected = "Error(Contract, #29)")]
fn test_preview_redeem_panics_when_shares_round_to_zero_assets() {
    let (env, vault_id) = setup_preview_env();
    let v = SingleRWAVaultClient::new(&env, &vault_id);
    // floor(50 * 100 / 100_000) = 0
    seed_price(&env, &vault_id, 100, 100_000);
    let _ = v.preview_redeem(&50);
}

#[test]
fn test_preview_deposit_zero_input_returns_zero() {
    let (env, vault_id) = setup_preview_env();
    let v = SingleRWAVaultClient::new(&env, &vault_id);
    seed_price(&env, &vault_id, 100, 100);
    assert_eq!(v.preview_deposit(&0), 0);
}

#[test]
fn test_preview_redeem_zero_input_returns_zero() {
    let (env, vault_id) = setup_preview_env();
    let v = SingleRWAVaultClient::new(&env, &vault_id);
    seed_price(&env, &vault_id, 100, 100);
    assert_eq!(v.preview_redeem(&0), 0);
}

/// `max_mint` uses floor conversion and must not panic when that floor is 0.
#[test]
fn test_max_mint_returns_zero_without_panic_when_deposit_cap_yields_no_shares() {
    let (env, vault_id) = setup_preview_env_with_cap(100);
    let v = SingleRWAVaultClient::new(&env, &vault_id);
    // User can deposit up to 100 assets, but at this price 100 assets → 0 shares.
    seed_price(&env, &vault_id, 10_000, 1);
    let alice = Address::generate(&env);
    assert_eq!(v.max_mint(&alice), 0);
}
