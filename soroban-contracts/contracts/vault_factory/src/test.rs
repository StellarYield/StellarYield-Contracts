#![allow(unused_imports, dead_code)]

// NOTE: high-level vault_factory tests that depended on loading external
// vault WASM have been disabled per request. The remaining tests live in
// tests.rs and rely on their own minimal setup.

// Keep this module compiling but without unused imports.

// WASM-loading helpers removed per request; no items remain in this module.
// Removed per request: depends on loading external WASM
/*
#[test]
fn test_create_single_rwa_vault() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, admin, asset, _, _, _) = setup_factory(&e);

    let name = String::from_str(&e, "Test Vault");
    let symbol = String::from_str(&e, "TV");
    let rwa_name = String::from_str(&e, "Real Estate");
    let rwa_symbol = String::from_str(&e, "RE");
    let rwa_uri = String::from_str(&e, "https://example.com");
    let maturity = 1735689600u64; // arbitrary future date

    let vault_addr = client.create_single_rwa_vault(
        &admin,
        &asset,
        &name,
        &symbol,
        &rwa_name,
        &rwa_symbol,
        &rwa_uri,
        &maturity,
    );

    // Verify registry
    assert!(client.is_registered_vault(&vault_addr));
    let all_vaults = client.get_all_vaults();
    assert!(all_vaults.contains(vault_addr.clone()));

    let info = client.get_vault_info(&vault_addr).unwrap();
    assert_eq!(info.name, name);
    assert_eq!(info.symbol, symbol);
    assert!(info.active);
    assert_eq!(info.vault_type, VaultType::SingleRwa);
}
*/

// Removed per request: depends on loading external WASM
/*
#[test]
fn test_create_single_rwa_vault_full() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, admin, asset, _, _, _) = setup_factory(&e);

    let params = BatchVaultParams {
        asset: asset.clone(),
        name: String::from_str(&e, "Full Vault"),
        symbol: String::from_str(&e, "FV"),
        share_decimals: 7u32, // SEP-41 convention
        rwa_name: String::from_str(&e, "Private Credit"),
        rwa_symbol: String::from_str(&e, "PC"),
        rwa_document_uri: String::from_str(&e, "https://doc.com"),
        rwa_category: String::from_str(&e, "Finance"),
        expected_apy: 500u32, // 5%
        maturity_date: 1800000000u64,
        funding_deadline: 1750000000u64,
        funding_target: 1000000000i128,
        min_deposit: 100i128,
        max_deposit_per_user: 1000000i128,
        early_redemption_fee_bps: 100u32, // 1%
    };

    let vault_addr = client.create_single_rwa_vault_full(&admin, &params);

    assert!(client.is_registered_vault(&vault_addr));
    let info = client.get_vault_info(&vault_addr).unwrap();
    assert_eq!(info.name, params.name);
}
*/

// Removed per request: depends on loading external WASM
/*
#[test]
fn test_batch_create_vaults() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, admin, asset, _, _, _) = setup_factory(&e);

    let mut batch = Vec::new(&e);
    for _i in 0..3 {
        batch.push_back(BatchVaultParams {
            asset: asset.clone(),
            name: String::from_str(&e, "Vault"),
            symbol: String::from_str(&e, "V"),
            share_decimals: 7u32, // SEP-41 convention
            rwa_name: String::from_str(&e, "RWA"),
            rwa_symbol: String::from_str(&e, "R"),
            rwa_document_uri: String::from_str(&e, "uri"),
            rwa_category: String::from_str(&e, "cat"),
            expected_apy: 0,
            maturity_date: 0,
            funding_deadline: 0,
            funding_target: 0,
            min_deposit: 0,
            max_deposit_per_user: 0,
            early_redemption_fee_bps: 0,
        });
    }

    let vaults = client.batch_create_vaults(&admin, &batch);
    assert_eq!(vaults.len(), 3);
    assert_eq!(client.get_vault_count(), 3);
}
*/

// Removed per request: depends on loading external WASM
/*
#[test]
fn test_create_vault_emits_event() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, admin, asset, _, _, _) = setup_factory(&e);

    let name = String::from_str(&e, "Event Vault");
    client.create_single_rwa_vault(
        &admin, &asset, &name, &name, // symbol same as name
        &name, &name, &name, &0,
    );

    let events = e.events().all();
    let last = events.last().expect("event must be emitted");

    // topics: (symbol_short!("v_create"), vault_addr, VaultType, name)
    let (_, topics, _) = last;
    let first_topic: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&e);
    assert_eq!(first_topic, symbol_short!("v_create"));
}
*/

// Removed per request: depends on loading external WASM
/*
#[test]
fn test_get_active_vaults_filters_inactive() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, admin, asset, _, _, _) = setup_factory(&e);

    let v1 = client.create_single_rwa_vault(
        &admin,
        &asset,
        &String::from_str(&e, "V1"),
        &String::from_str(&e, "V1"),
        &String::from_str(&e, ""),
        &String::from_str(&e, ""),
        &String::from_str(&e, ""),
        &0,
    );
    let v2 = client.create_single_rwa_vault(
        &admin,
        &asset,
        &String::from_str(&e, "V2"),
        &String::from_str(&e, "V2"),
        &String::from_str(&e, ""),
        &String::from_str(&e, ""),
        &String::from_str(&e, ""),
        &0,
    );

    assert_eq!(client.get_active_vaults().len(), 2);

    client.set_vault_status(&admin, &v1, &false);

    let active = client.get_active_vaults();
    assert_eq!(active.len(), 1);
    assert!(active.contains(v2));
}
*/

// Some constructor and error-path factory tests removed per request

// Full Lifecycle Integration Test removed per request

// ─────────────────────────────────────────────────────────────────────────────
// Mock Contracts for Integration Test (in separate module to avoid symbol conflicts)
// ─────────────────────────────────────────────────────────────────────────────

mod integration_test_mocks {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[contract]
    pub struct IntegrationMockUsdc;

    #[contractimpl]
    impl IntegrationMockUsdc {
        pub fn balance(e: Env, id: Address) -> i128 {
            e.storage().persistent().get(&id).unwrap_or(0i128)
        }

        pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let from_bal: i128 = e.storage().persistent().get(&from).unwrap_or(0);
            if from_bal < amount {
                panic!("insufficient token balance");
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
    pub struct IntegrationMockZkme;

    #[contractimpl]
    impl IntegrationMockZkme {
        pub fn has_approved(e: Env, _cooperator: Address, user: Address) -> bool {
            e.storage().instance().get(&user).unwrap_or(false)
        }

        pub fn approve_user(e: Env, user: Address) {
            e.storage().instance().set(&user, &true);
        }
    }
}
