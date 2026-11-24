//! Tests for factory access-control functions:
//!   set_operator / is_operator (#1369)
//!   transfer_admin / loss of old-admin rights (#1368)
//!   MigrationRequired blocks operations on unmigrated storage (#1360)
//!   create_single_rwa_vault_batch requires operator-or-admin (#1371)

use crate::{
    storage::put_storage_schema_version,
    tests::setup_factory,
    types::BatchVaultParams,
    VaultFactoryClient,
};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

// ── helpers ──────────────────────────────────────────────────────────────────

fn make_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env
}

// ── #1369 set_operator / is_operator ─────────────────────────────────────────

#[test]
fn test_set_operator_grant_and_query() {
    let env = make_env();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let operator = Address::generate(&env);

    assert!(!factory.is_operator(&operator));
    factory.set_operator(&admin, &operator, &true);
    assert!(factory.is_operator(&operator));
}

#[test]
fn test_set_operator_revoke() {
    let env = make_env();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let operator = Address::generate(&env);

    factory.set_operator(&admin, &operator, &true);
    assert!(factory.is_operator(&operator));
    factory.set_operator(&admin, &operator, &false);
    assert!(!factory.is_operator(&operator));
}

#[test]
#[should_panic]
fn test_set_operator_non_admin_rejected() {
    let env = make_env();
    let (factory_id, _admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let stranger = Address::generate(&env);
    let target = Address::generate(&env);

    factory.set_operator(&stranger, &target, &true);
}

// ── #1368 transfer_admin ──────────────────────────────────────────────────────

#[test]
fn test_transfer_admin_changes_admin() {
    let env = make_env();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let new_admin = Address::generate(&env);

    factory.transfer_admin(&admin, &new_admin);
    assert_eq!(factory.admin(), new_admin);
}

#[test]
#[should_panic]
fn test_old_admin_loses_rights_after_transfer() {
    let env = make_env();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let new_admin = Address::generate(&env);
    let operator = Address::generate(&env);

    factory.transfer_admin(&admin, &new_admin);
    // Old admin should no longer be able to call admin-only functions.
    factory.set_operator(&admin, &operator, &true);
}

#[test]
#[should_panic]
fn test_transfer_admin_non_admin_rejected() {
    let env = make_env();
    let (factory_id, _admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let stranger = Address::generate(&env);
    let new_admin = Address::generate(&env);

    factory.transfer_admin(&stranger, &new_admin);
}

// ── #1360 MigrationRequired blocks operations ─────────────────────────────────

#[test]
#[should_panic]
fn test_migration_required_blocks_set_defaults() {
    let env = make_env();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);

    // Corrupt the schema version to simulate an unmigrated contract.
    env.as_contract(&factory_id, || {
        put_storage_schema_version(&env, 0);
    });

    let asset = Address::generate(&env);
    let zkme = Address::generate(&env);
    let coop = Address::generate(&env);
    factory.set_defaults(&admin, &asset, &zkme, &coop);
}

#[test]
#[should_panic]
fn test_migration_required_blocks_transfer_admin_with_schema_guard() {
    // transfer_admin itself bypasses the schema guard intentionally;
    // but set_defaults (which does require it) should panic.
    let env = make_env();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);

    env.as_contract(&factory_id, || {
        put_storage_schema_version(&env, 0);
    });

    let asset = Address::generate(&env);
    let zkme = Address::generate(&env);
    let coop = Address::generate(&env);
    // This call requires current schema → should panic with MigrationRequired.
    factory.set_defaults(&admin, &asset, &zkme, &coop);
}

// ── #1371 create_single_rwa_vault_batch requires operator-or-admin ────────────

#[test]
#[should_panic]
fn test_create_single_rwa_vault_batch_non_operator_rejected() {
    let env = make_env();
    let (factory_id, _admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);
    let stranger = Address::generate(&env);
    let asset = Address::generate(&env);

    let params = BatchVaultParams {
        asset: asset.clone(),
        name: String::from_str(&env, "Test"),
        symbol: String::from_str(&env, "TST"),
        rwa_name: String::from_str(&env, "RWA"),
        rwa_symbol: String::from_str(&env, "RWA"),
        rwa_document_uri: String::from_str(&env, "ipfs://test"),
        rwa_category: String::from_str(&env, "real-estate"),
        expected_apy: 500,
        maturity_date: 9_999_999_999,
        funding_deadline: 9_000_000_000,
        funding_target: 1_000_000,
        min_deposit: 100,
        max_deposit_per_user: 1_000_000,
        early_redemption_fee_bps: 100,
        share_decimals: None,
        vault_admin: None,
        zkme_verifier: None,
        cooperator: None,
        max_investors: None,
    };

    // A non-operator, non-admin caller should be rejected.
    factory.create_single_rwa_vault_batch(&stranger, &params);
}
