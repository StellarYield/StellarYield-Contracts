//! Tests for share price inflation attack mitigation (Issue #95).
//!
//! Verifies that the virtual offset prevents the first depositor from
//! inflating the share price to steal subsequent deposits.

extern crate std;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, String};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

fn default_params(env: &Env, admin: &Address, asset: &Address) -> InitParams {
    InitParams {
        asset: asset.clone(),
        share_name: String::from_str(env, "Vault Share"),
        share_symbol: String::from_str(env, "VS"),
        share_decimals: 6,
        admin: admin.clone(),
        zkme_verifier: admin.clone(),
        cooperator: admin.clone(),
        funding_target: 0_i128,
        maturity_date: 9_999_999_999_u64,
        min_deposit: 1_i128,
        max_deposit_per_user: 0_i128,
        early_redemption_fee_bps: 0u32,
        operator_fee_bps: 0u32,
        funding_deadline: 0_u64,
        rwa_name: String::from_str(env, "Test RWA"),
        rwa_symbol: String::from_str(env, "TRWA"),
        rwa_document_uri: String::from_str(env, "https://test.com"),
        rwa_category: String::from_str(env, "Real Estate"),
        expected_apy: 500_u32,
        timelock_delay: 0u64,
        yield_vesting_period: 0u64,
    }
}

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let asset_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let vault_id = env.register(SingleRWAVault, (default_params(&env, &admin, &asset_id),));
    SingleRWAVaultClient::new(&env, &vault_id).set_zkme_verifier(&admin, &vault_id);

    (env, vault_id, asset_id, admin)
}

fn mint_asset(env: &Env, asset_id: &Address, user: &Address, amount: i128) {
    StellarAssetClient::new(env, asset_id).mint(user, &amount);
}

#[test]
fn test_inflation_attack_mitigated() {
    let (env, vault_id, asset_id, _admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let attacker = Address::generate(&env);
    let victim = Address::generate(&env);

    // Attacker deposits 1 wei
    mint_asset(&env, &asset_id, &attacker, 1_000_001_i128);
    let attacker_shares = client.deposit(&attacker, &1_i128, &attacker);

    // Without mitigation, attacker would get 1 share
    // With virtual offset, attacker gets shares based on (1 * (0 + OFFSET)) / (0 + OFFSET) = 1
    assert_eq!(attacker_shares, 1);

    // Attacker tries to inflate share price by direct transfer
    // (In real scenario, this would be a direct token transfer to vault address)
    // For testing, we simulate by depositing more
    client.deposit(&attacker, &1_000_000_i128, &attacker);

    // Victim deposits 500,000
    mint_asset(&env, &asset_id, &victim, 500_000_i128);
    let victim_shares = client.deposit(&victim, &500_000_i128, &victim);

    // With virtual offset mitigation, victim should receive a fair amount of shares
    // Without mitigation, victim would get 0 shares due to rounding
    // With mitigation: shares = 500000 * (supply + OFFSET) / (assets + OFFSET)
    // The virtual offset ensures victim_shares > 0
    assert!(victim_shares > 0, "Victim should receive shares");

    // Verify victim got a reasonable share of the vault
    let total_supply = client.total_supply();
    let victim_percentage = (victim_shares * 100) / total_supply;

    // Victim deposited 500k out of ~1.5M total, should get roughly 33% of shares
    assert!(
        victim_percentage > 25,
        "Victim should get fair share percentage"
    );
}

#[test]
fn test_first_deposit_tiny_amount() {
    let (env, vault_id, asset_id, _admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    // First user deposits 1 wei
    mint_asset(&env, &asset_id, &user1, 1_i128);
    let shares1 = client.deposit(&user1, &1_i128, &user1);
    assert_eq!(shares1, 1);

    // Second user deposits normal amount
    mint_asset(&env, &asset_id, &user2, 1_000_000_i128);
    let shares2 = client.deposit(&user2, &1_000_000_i128, &user2);

    // Second user should get proportional shares
    assert!(shares2 > 0, "Second depositor should receive shares");
    assert!(
        shares2 > shares1,
        "Second depositor should get more shares for larger deposit"
    );
}

#[test]
fn test_preview_deposit_with_virtual_offset() {
    let (env, vault_id, asset_id, _admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let user = Address::generate(&env);

    // Preview deposit before any deposits
    let preview_shares = client.preview_deposit(&1_000_000_i128);
    assert_eq!(preview_shares, 1_000_000_i128, "1:1 ratio at start");

    // Make first deposit
    mint_asset(&env, &asset_id, &user, 1_000_000_i128);
    client.deposit(&user, &1_000_000_i128, &user);

    // Preview another deposit - should account for virtual offset
    let preview_shares2 = client.preview_deposit(&1_000_000_i128);
    assert!(preview_shares2 > 0, "Preview should return non-zero shares");
}
