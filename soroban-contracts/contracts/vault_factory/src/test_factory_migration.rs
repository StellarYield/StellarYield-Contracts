//! Tests for VaultFactory schema versioning and migration.

use crate::{tests::setup_factory, VaultFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_factory_versioning_and_migration() {
    let env = Env::default();
    env.mock_all_auths();
    let (factory_id, admin) = setup_factory(&env);
    let factory = VaultFactoryClient::new(&env, &factory_id);

    // Initially at version 1
    assert_eq!(factory.contract_version(), 1u32);
    assert_eq!(factory.storage_schema_version(), 1u32);

    // Migrate when already up-to-date: should be no-op and not error
    factory.migrate(&admin);
    assert_eq!(factory.storage_schema_version(), 1u32);

    // Verify version guard allows admin functions (e.g., set_defaults)
    let asset = Address::generate(&env);
    let zkme = Address::generate(&env);
    let coop = Address::generate(&env);
    factory.set_defaults(&admin, &asset, &zkme, &coop);
}
