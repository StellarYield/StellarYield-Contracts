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

// ─────────────────────────────────────────────────────────────────────────────
// Additional Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod factory_tests {
    use super::*;
    use crate::storage::*;
    use crate::types::*;
    use crate::{VaultFactory, VaultFactoryClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, BytesN, Env, String};

    /// Helper to deploy and initialize a VaultFactory.
    fn setup_factory(e: &Env) -> (Address, Address, VaultFactoryClient) {
        let admin = Address::generate(e);
        let asset = Address::generate(e);
        let zkme = Address::generate(e);
        let coop = Address::generate(e);
        let wasm_hash = BytesN::<32>::from_array(e, &[0u8; 32]);

        let factory_id = e.register(
            VaultFactory,
            (
                admin.clone(),
                asset.clone(),
                zkme.clone(),
                coop.clone(),
                wasm_hash,
            ),
        );
        let client = VaultFactoryClient::new(e, &factory_id);
        (factory_id, admin, client)
    }

    /// Helper to inject a vault record directly into factory storage.
    fn inject_vault(e: &Env, factory_id: &Address, asset: &Address, active: bool) -> Address {
        let vault = Address::generate(e);
        let info = VaultInfo {
            vault: vault.clone(),
            asset: asset.clone(),
            vault_type: VaultType::SingleRwa,
            name: String::from_str(e, "Test Vault"),
            symbol: String::from_str(e, "TV"),
            active,
            created_at: e.ledger().timestamp(),
            operator_fee_bps: 200,
            maturity_date: e.ledger().timestamp() + 1_000_000,
            expected_apy: 500,
        };

        e.as_contract(factory_id, || {
            put_vault_info(e, &vault, info.clone());
            register_vault(e, vault.clone());
            push_vaults_by_asset(e, asset, &vault);
            let deploy_id = increment_vault_deploy_counter(e);
            put_vault_by_deploy_id(e, deploy_id, &vault);
        });

        vault
    }

    // ─── Test 1: get_vaults_by_asset returns vaults for specific asset ───────

    /// Test that get_vaults_by_asset correctly returns only vaults
    /// associated with a specific underlying asset address.
    #[test]
    fn test_get_vaults_by_asset_filters_correctly() {
        let e = Env::default();
        e.mock_all_auths();

        let (factory_id, _admin, client) = setup_factory(&e);

        let asset_a = Address::generate(&e);
        let asset_b = Address::generate(&e);

        // Create vaults for asset_a
        let vault_a1 = inject_vault(&e, &factory_id, &asset_a, true);
        let vault_a2 = inject_vault(&e, &factory_id, &asset_a, true);

        // Create vaults for asset_b
        let vault_b1 = inject_vault(&e, &factory_id, &asset_b, true);

        // Query vaults by asset_a
        let vaults_a = client.get_vaults_by_asset(&asset_a);
        assert_eq!(vaults_a.len(), 2, "Should return 2 vaults for asset_a");
        assert!(vaults_a.contains(vault_a1));
        assert!(vaults_a.contains(vault_a2));
        assert!(!vaults_a.contains(vault_b1.clone()));

        // Query vaults by asset_b
        let vaults_b = client.get_vaults_by_asset(&asset_b);
        assert_eq!(vaults_b.len(), 1, "Should return 1 vault for asset_b");
        assert!(vaults_b.contains(vault_b1));
        assert!(!vaults_b.contains(vault_a1.clone()));
        assert!(!vaults_b.contains(vault_a2.clone()));
    }

    // ─── Test 2: vault_exists_by_name_symbol detects duplicates ──────────────

    /// Test that vault_exists_by_name_symbol correctly identifies
    /// existing vaults by their name and symbol combination.
    #[test]
    fn test_vault_exists_by_name_symbol() {
        let e = Env::default();
        e.mock_all_auths();

        let (factory_id, _admin, client) = setup_factory(&e);
        let asset = Address::generate(&e);

        // Inject a vault with specific name and symbol
        let vault1 = inject_vault(&e, &factory_id, &asset, true);
        let name1 = String::from_str(&e, "Unique Vault");
        let symbol1 = String::from_str(&e, "UNQ");

        e.as_contract(&factory_id, || {
            let mut info = get_vault_info(&e, &vault1).unwrap();
            info.name = name1.clone();
            info.symbol = symbol1.clone();
            put_vault_info(&e, &vault1, info);
        });

        // Test that the vault is found by name and symbol
        let found = client.vault_exists_by_name_symbol(&name1, &symbol1);
        assert!(found.is_some(), "Should find vault with matching name and symbol");
        assert_eq!(found.unwrap(), vault1);

        // Test that non-existent name/symbol combination returns None
        let not_found = client.vault_exists_by_name_symbol(
            &String::from_str(&e, "Non Existent"),
            &String::from_str(&e, "NEX"),
        );
        assert!(
            not_found.is_none(),
            "Should return None for non-existent name/symbol"
        );

        // Test that partial match (only name) doesn't match
        let partial = client.vault_exists_by_name_symbol(&name1, &String::from_str(&e, "WRONG"));
        assert!(
            partial.is_none(),
            "Should not match if only name matches but symbol differs"
        );
    }

    // ─── Test 3: list_recent_vaults returns newest vaults first ──────────────

    /// Test that list_recent_vaults returns vaults in reverse chronological
    /// order (newest first) based on deployment order.
    #[test]
    fn test_list_recent_vaults_newest_first() {
        let e = Env::default();
        e.mock_all_auths();

        let (factory_id, _admin, client) = setup_factory(&e);
        let asset = Address::generate(&e);

        // Create vaults in sequence (simulating deployment order)
        let vault1 = inject_vault(&e, &factory_id, &asset, true);
        let vault2 = inject_vault(&e, &factory_id, &asset, true);
        let vault3 = inject_vault(&e, &factory_id, &asset, true);

        // Query recent vaults
        let recent = client.list_recent_vaults(&10);

        assert_eq!(recent.len(), 3, "Should return 3 vaults");

        // Verify reverse chronological order (newest first)
        assert_eq!(recent.get(0).unwrap(), vault3, "First should be vault3");
        assert_eq!(recent.get(1).unwrap(), vault2, "Second should be vault2");
        assert_eq!(recent.get(2).unwrap(), vault1, "Third should be vault1");
    }

    // ─── Test 4: list_recent_vaults respects limit parameter ─────────────────

    /// Test that list_recent_vaults correctly limits the number of
    /// returned vaults according to the limit parameter.
    #[test]
    fn test_list_recent_vaults_respects_limit() {
        let e = Env::default();
        e.mock_all_auths();

        let (factory_id, _admin, client) = setup_factory(&e);
        let asset = Address::generate(&e);

        // Create 5 vaults
        inject_vault(&e, &factory_id, &asset, true);
        inject_vault(&e, &factory_id, &asset, true);
        let vault3 = inject_vault(&e, &factory_id, &asset, true);
        let vault4 = inject_vault(&e, &factory_id, &asset, true);
        let vault5 = inject_vault(&e, &factory_id, &asset, true);

        // Query with limit of 3
        let recent = client.list_recent_vaults(&3);

        assert_eq!(recent.len(), 3, "Should return exactly 3 vaults");

        // Verify we get the 3 most recent
        assert_eq!(recent.get(0).unwrap(), vault5);
        assert_eq!(recent.get(1).unwrap(), vault4);
        assert_eq!(recent.get(2).unwrap(), vault3);

        // Test zero limit
        let empty = client.list_recent_vaults(&0);
        assert_eq!(empty.len(), 0, "Zero limit should return empty vec");
    }

    // ─── Test 5: get_registry_stats provides accurate metrics ────────────────

    /// Test that get_registry_stats returns correct statistics about
    /// the vault registry including total count, active count, and latest vault.
    #[test]
    fn test_get_registry_stats_accuracy() {
        let e = Env::default();
        e.mock_all_auths();

        let (factory_id, _admin, client) = setup_factory(&e);
        let asset = Address::generate(&e);

        // Initial stats (empty registry)
        let stats_empty = client.get_registry_stats();
        assert_eq!(stats_empty.total_vaults, 0, "Initial total should be 0");
        assert_eq!(stats_empty.active_vaults, 0, "Initial active should be 0");
        assert!(
            stats_empty.latest_vault.is_none(),
            "Latest vault should be None when empty"
        );

        // Create some vaults (mix of active and inactive)
        inject_vault(&e, &factory_id, &asset, true); // active
        inject_vault(&e, &factory_id, &asset, false); // inactive
        inject_vault(&e, &factory_id, &asset, true); // active
        let latest = inject_vault(&e, &factory_id, &asset, true); // active (latest)

        // Query stats after adding vaults
        let stats = client.get_registry_stats();
        assert_eq!(stats.total_vaults, 4, "Should have 4 total vaults");
        assert_eq!(stats.active_vaults, 3, "Should have 3 active vaults");
        assert!(stats.latest_vault.is_some(), "Should have a latest vault");
        assert_eq!(
            stats.latest_vault.unwrap(),
            latest,
            "Latest vault should be the most recently added"
        );
    }
}
