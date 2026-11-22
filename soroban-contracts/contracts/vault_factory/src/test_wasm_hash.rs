//! Tests for set_vault_wasm_hash — error paths and happy path (#1370).

extern crate std;

use soroban_sdk::{testutils::Address as _, BytesN, Env};

use crate::{VaultFactory, VaultFactoryClient};

fn setup(e: &Env) -> (Address, Address) {
    use soroban_sdk::Address;
    let admin = Address::generate(e);
    let asset = Address::generate(e);
    let zkme = Address::generate(e);
    let coop = Address::generate(e);
    let init_hash = BytesN::<32>::from_array(e, &[1u8; 32]);
    let factory_id = e.register(
        VaultFactory,
        (admin.clone(), asset.clone(), zkme.clone(), coop.clone(), init_hash),
    );
    (factory_id, admin)
}

use soroban_sdk::Address;

/// Non-admin caller is rejected with NotAuthorized (#3).
#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_set_vault_wasm_hash_non_admin_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (factory_id, _admin) = setup(&env);
    let client = VaultFactoryClient::new(&env, &factory_id);

    let non_admin = Address::generate(&env);
    let new_hash = BytesN::<32>::from_array(&env, &[2u8; 32]);
    client.set_vault_wasm_hash(&non_admin, &new_hash);
}

/// All-zero hash is rejected with InvalidWasmHash (#8).
#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_set_vault_wasm_hash_zero_hash_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (factory_id, admin) = setup(&env);
    let client = VaultFactoryClient::new(&env, &factory_id);

    let zero_hash = BytesN::<32>::from_array(&env, &[0u8; 32]);
    client.set_vault_wasm_hash(&admin, &zero_hash);
}

/// Admin can update to a non-zero hash and the stored hash changes.
#[test]
fn test_set_vault_wasm_hash_admin_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (factory_id, admin) = setup(&env);
    let client = VaultFactoryClient::new(&env, &factory_id);

    let new_hash = BytesN::<32>::from_array(&env, &[0xABu8; 32]);
    client.set_vault_wasm_hash(&admin, &new_hash);
    assert_eq!(client.vault_wasm_hash(), new_hash);
}

/// Setting the hash a second time overwrites the previous value.
#[test]
fn test_set_vault_wasm_hash_update_twice() {
    let env = Env::default();
    env.mock_all_auths();
    let (factory_id, admin) = setup(&env);
    let client = VaultFactoryClient::new(&env, &factory_id);

    let hash_a = BytesN::<32>::from_array(&env, &[0x11u8; 32]);
    let hash_b = BytesN::<32>::from_array(&env, &[0x22u8; 32]);
    client.set_vault_wasm_hash(&admin, &hash_a);
    client.set_vault_wasm_hash(&admin, &hash_b);
    assert_eq!(client.vault_wasm_hash(), hash_b);
}
