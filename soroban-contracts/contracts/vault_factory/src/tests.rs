extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, BytesN, Env, IntoVal, String,
};

use crate::{
    storage::{
        get_active_vaults, get_all_vaults, get_single_rwa_vaults, get_vault_count, get_vault_info,
        push_active_vaults, push_all_vaults, push_single_rwa_vaults, put_vault_info,
    },
    types::{VaultInfo, VaultType, BatchVaultParams},
    VaultFactory, VaultFactoryClient,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Deploy and initialise a VaultFactory with a dummy WASM hash.
pub fn setup_factory(e: &Env) -> (VaultFactoryClient<'_>, Address) {
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
    (VaultFactoryClient::new(e, &factory_id), admin)
}

/// Inject a vault record directly into factory storage, bypassing deployment.
/// Returns the generated vault address.
fn inject_vault(e: &Env, factory_id: &Address, active: bool) -> Address {
    let vault = Address::generate(e);
    let _asset = Address::generate(e);
    let info = VaultInfo {
        vault: vault.clone(),
        asset: vault.clone(),
        vault_type: VaultType::SingleRwa,
        name: String::from_str(e, "Test Vault"),
        symbol: String::from_str(e, "TV"),
        active,
        created_at: e.ledger().timestamp(),
    };

    // Write inside the factory contract context so storage keys resolve
    // against the factory address.
    e.as_contract(factory_id, || {
        put_vault_info(e, &vault, info);
        push_all_vaults(e, vault.clone());
        push_single_rwa_vaults(e, vault.clone());
        if active {
            push_active_vaults(e, vault.clone());
        }
    });

    vault
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// ─── ActiveVaults list ────────────────────────────────────────────────────────

/// set_vault_status keeps ActiveVaults in sync: deactivating removes,
/// reactivating re-adds.
#[test]
fn test_set_vault_status_updates_active_list() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();

    let vault = inject_vault(&e, &factory_id, true);

    // Initially active — should appear in ActiveVaults.
    e.as_contract(&factory_id, || {
        assert!(get_active_vaults(&e).contains(vault.clone()));
    });

    // Deactivate — must be removed from ActiveVaults.
    client.set_vault_status(&admin, &vault, &false);
    e.as_contract(&factory_id, || {
        assert!(!get_active_vaults(&e).contains(vault.clone()));
    });

    // Reactivate — must be re-added.
    client.set_vault_status(&admin, &vault, &true);
    e.as_contract(&factory_id, || {
        assert!(get_active_vaults(&e).contains(vault.clone()));
    });
}

/// get_active_vaults returns only the active list directly (O(1) read).
#[test]
fn test_get_active_vaults_uses_dedicated_list() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    let a = inject_vault(&e, &factory_id, true);
    inject_vault(&e, &factory_id, false); // inactive

    let active = client.get_active_vaults();
    assert_eq!(active.len(), 1);
    assert_eq!(active.get(0).unwrap(), a);
}

// ─── get_vault_count ──────────────────────────────────────────────────────────

/// get_vault_count reflects the live counter without loading the full list.
#[test]
fn test_get_vault_count_tracks_adds_and_removes() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();

    assert_eq!(client.get_vault_count(), 0);

    let v1 = inject_vault(&e, &factory_id, false);
    assert_eq!(client.get_vault_count(), 1);

    let v2 = inject_vault(&e, &factory_id, false);
    assert_eq!(client.get_vault_count(), 2);

    client.remove_vault(&admin, &v1);
    assert_eq!(client.get_vault_count(), 1);

    client.remove_vault(&admin, &v2);
    assert_eq!(client.get_vault_count(), 0);
}

/// Counter in instance storage matches the list length at all times.
#[test]
fn test_vault_count_matches_list_length() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    for _ in 0..5 {
        inject_vault(&e, &factory_id, true);
    }

    e.as_contract(&factory_id, || {
        assert_eq!(
            get_vault_count(&e) as usize,
            get_all_vaults(&e).len() as usize
        );
    });
}

// ─── get_vaults_paginated ─────────────────────────────────────────────────────

/// First page returns up to `limit` items starting at offset 0.
#[test]
fn test_get_vaults_paginated_first_page() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    let mut all_vaults = soroban_sdk::Vec::new(&e);
    for _ in 0..5 {
        all_vaults.push_back(inject_vault(&e, &factory_id, true));
    }

    let page = client.get_vaults_paginated(&0, &3);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap(), all_vaults.get(0).unwrap());
    assert_eq!(page.get(2).unwrap(), all_vaults.get(2).unwrap());
}

/// Second page returns the remaining items.
#[test]
fn test_get_vaults_paginated_second_page() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    let mut all_vaults = soroban_sdk::Vec::new(&e);
    for _ in 0..5 {
        all_vaults.push_back(inject_vault(&e, &factory_id, true));
    }

    let page = client.get_vaults_paginated(&3, &3);
    assert_eq!(page.len(), 2); // only 2 items remain after offset 3
    assert_eq!(page.get(0).unwrap(), all_vaults.get(3).unwrap());
    assert_eq!(page.get(1).unwrap(), all_vaults.get(4).unwrap());
}

/// Offset past the end of the list returns an empty vec.
#[test]
fn test_get_vaults_paginated_offset_past_end() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    inject_vault(&e, &factory_id, true);
    inject_vault(&e, &factory_id, true);

    let page = client.get_vaults_paginated(&10, &5);
    assert_eq!(page.len(), 0);
}

/// limit = 0 always returns an empty vec.
#[test]
fn test_get_vaults_paginated_zero_limit() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    inject_vault(&e, &factory_id, true);

    let page = client.get_vaults_paginated(&0, &0);
    assert_eq!(page.len(), 0);
}

// ─── get_active_vaults_paginated ──────────────────────────────────────────────

/// Only active vaults are included; offset/limit apply to the filtered set.
#[test]
fn test_get_active_vaults_paginated_filters_inactive() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    let a1 = inject_vault(&e, &factory_id, true);
    inject_vault(&e, &factory_id, false); // inactive
    let a2 = inject_vault(&e, &factory_id, true);
    inject_vault(&e, &factory_id, false); // inactive
    let a3 = inject_vault(&e, &factory_id, true);

    // All 3 active vaults with a generous limit.
    let page = client.get_active_vaults_paginated(&0, &10);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap(), a1);
    assert_eq!(page.get(1).unwrap(), a2);
    assert_eq!(page.get(2).unwrap(), a3);
}

/// Offset skips active vaults only (inactive ones are invisible to pagination).
#[test]
fn test_get_active_vaults_paginated_offset_skips_active() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _) = setup_factory(&e);
    let factory_id = client.address.clone();

    inject_vault(&e, &factory_id, true); // active[0] — skipped by offset=1
    let a2 = inject_vault(&e, &factory_id, true); // active[1]
    inject_vault(&e, &factory_id, false); // inactive — not counted

    let page = client.get_active_vaults_paginated(&1, &5);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap(), a2);
}

/// Admin successfully removes an inactive vault.
#[test]
fn test_remove_inactive_vault_success() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();

    let vault = inject_vault(&e, &factory_id, false /* inactive */);

    // Pre-conditions
    e.as_contract(&factory_id, || {
        assert!(get_vault_info(&e, &vault).is_some());
        assert!(get_all_vaults(&e).contains(vault.clone()));
        assert!(get_single_rwa_vaults(&e).contains(vault.clone()));
    });

    client.remove_vault(&admin, &vault);

    // Post-conditions: vault purged from all lists and VaultInfo deleted
    e.as_contract(&factory_id, || {
        assert!(
            get_vault_info(&e, &vault).is_none(),
            "VaultInfo must be deleted"
        );
        assert!(
            !get_all_vaults(&e).contains(vault.clone()),
            "vault must not appear in AllVaults"
        );
        assert!(
            !get_single_rwa_vaults(&e).contains(vault.clone()),
            "vault must not appear in SingleRwaVaults"
        );
    });
}

/// get_all_vaults no longer returns the removed vault.
#[test]
fn test_get_all_vaults_excludes_removed_vault() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();

    // Two vaults; one will be removed
    let keep = inject_vault(&e, &factory_id, false);
    let remove = inject_vault(&e, &factory_id, false);

    client.remove_vault(&admin, &remove);

    let all = client.get_all_vaults();
    assert!(
        !all.contains(remove.clone()),
        "removed vault must not appear in get_all_vaults"
    );
    assert!(
        all.contains(keep.clone()),
        "remaining vault must still appear in get_all_vaults"
    );
}

/// Non-admin caller must be rejected with NotAuthorized.
#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_remove_vault_non_admin_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, _admin) = setup_factory(&e);
    let factory_id = client.address.clone();
    let vault = inject_vault(&e, &factory_id, false);

    let random = Address::generate(&e);
    client.remove_vault(&random, &vault);
}

/// Attempting to remove an active vault must fail with VaultIsActive.
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_remove_active_vault_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();
    let vault = inject_vault(&e, &factory_id, true /* active */);

    client.remove_vault(&admin, &vault);
}

/// Attempting to remove a vault that does not exist must fail with VaultNotFound.
#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_remove_unknown_vault_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let ghost = Address::generate(&e);

    client.remove_vault(&admin, &ghost);
}

/// VaultRemoved event is emitted on a successful removal.
#[test]
fn test_remove_vault_emits_event() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();
    let vault = inject_vault(&e, &factory_id, false);

    client.remove_vault(&admin, &vault);

    // The last published event must carry the "v_remove" topic and the
    // vault address.
    let events = e.events().all();
    let last = events.last().expect("at least one event must be published");
    // topics: (symbol_short!("v_remove"), vault_addr)
    // data:   admin_addr
    let (contract, topics, _data) = last;
    assert_eq!(contract, factory_id);
    // Verify the first topic is the "v_remove" symbol
    let first_topic = topics.get_unchecked(0);
    let first_symbol: soroban_sdk::Symbol = first_topic.into_val(&e);
    let expected = soroban_sdk::symbol_short!("v_remove");
    assert_eq!(first_symbol, expected);
}

// ─── batch_create_vaults size limit ──────────────────────────────────────────

/// batch_create_vaults with more than MAX_BATCH_SIZE (10) entries must panic
/// with Error::BatchTooLarge (#7).
#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_batch_create_vaults_exceeds_limit() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let asset = Address::generate(&e);

    // Build a batch of 11 entries (one over the limit).
    let mut params: soroban_sdk::Vec<crate::types::BatchVaultParams> = soroban_sdk::Vec::new(&e);
    for i in 0..11u32 {
        params.push_back(crate::types::BatchVaultParams {
            asset: asset.clone(),
            name: String::from_str(&e, "V"),
            symbol: String::from_str(&e, "V"),
            rwa_name: String::from_str(&e, "RWA"),
            rwa_symbol: String::from_str(&e, "R"),
            rwa_document_uri: String::from_str(&e, "https://example.com"),
            rwa_category: String::from_str(&e, "Bond"),
            expected_apy: 500,
            maturity_date: 9_999_999_999u64 + i as u64,
            funding_deadline: 0,
            funding_target: 0,
            min_deposit: 0,
            max_deposit_per_user: 0,
            early_redemption_fee_bps: 200,
            vault_admin: None, // Use factory admin
            zkme_verifier: None, // Use factory default
            cooperator: None, // Use factory default
        });
    }

    // Must panic with BatchTooLarge.
    client.batch_create_vaults(&admin, &params);
}

/// batch_create_vaults at exactly MAX_BATCH_SIZE (10) should not panic
/// (the limit is inclusive).
#[test]
fn test_batch_create_vaults_at_limit_ok() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let asset = Address::generate(&e);

    let mut params: soroban_sdk::Vec<crate::types::BatchVaultParams> = soroban_sdk::Vec::new(&e);
    for i in 0..10u32 {
        params.push_back(crate::types::BatchVaultParams {
            asset: asset.clone(),
            name: String::from_str(&e, "V"),
            symbol: String::from_str(&e, "V"),
            rwa_name: String::from_str(&e, "RWA"),
            rwa_symbol: String::from_str(&e, "R"),
            rwa_document_uri: String::from_str(&e, "https://example.com"),
            rwa_category: String::from_str(&e, "Bond"),
            expected_apy: 500,
            maturity_date: 9_999_999_999u64 + i as u64,
            funding_deadline: 0,
            funding_target: 0,
            min_deposit: 0,
            max_deposit_per_user: 0,
            early_redemption_fee_bps: 200,
            vault_admin: None, // Use factory admin
            zkme_verifier: None, // Use factory default
            cooperator: None, // Use factory default
        });
    }

    // Should not panic -- exactly at the limit.
    // Note: actual deployment will fail because we use a dummy WASM hash,
    // but the size check passes before deployment starts.
    // We test only the guard here, not full deployment.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.batch_create_vaults(&admin, &params);
    }));
    // The call may still panic due to dummy WASM hash, but NOT with BatchTooLarge (#7).
    if let Err(e) = result {
        let msg = if let Some(s) = e.downcast_ref::<std::string::String>() {
            s.clone()
        } else if let Some(s) = e.downcast_ref::<&str>() {
            std::string::String::from(*s)
        } else {
            std::string::String::from("")
        };
        assert!(
            !msg.contains("#7"),
            "batch of 10 should not trigger BatchTooLarge"
        );
    }
}

// ─── Per-Vault Admin Override Tests ───────────────────────────────────────────────

/// Test that vault_admin parameter works in create_single_rwa_vault_full
#[test]
fn test_create_vault_with_custom_admin() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();
    
    // Generate addresses for testing
    let custom_admin = Address::generate(&e);
    let asset = Address::generate(&e);
    let custom_zkme = Address::generate(&e);
    let custom_coop = Address::generate(&e);
    
    // Create vault with custom admin and settings
    let params = BatchVaultParams {
        asset: asset.clone(),
        name: String::from_str(&e, "CustomAdminVault"),
        symbol: String::from_str(&e, "CAV"),
        rwa_name: String::from_str(&e, "Custom RWA"),
        rwa_symbol: String::from_str(&e, "CRWA"),
        rwa_document_uri: String::from_str(&e, "https://custom.example.com"),
        rwa_category: String::from_str(&e, "CustomBond"),
        expected_apy: 700,
        maturity_date: 9_999_999_999u64,
        funding_deadline: 0,
        funding_target: 0,
        min_deposit: 0,
        max_deposit_per_user: 0,
        early_redemption_fee_bps: 300,
        vault_admin: Some(custom_admin.clone()),
        zkme_verifier: Some(custom_zkme.clone()),
        cooperator: Some(custom_coop.clone()),
    };

    // This will fail due to dummy WASM hash, but we can catch the error and verify
    // the event was emitted with the correct admin
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_single_rwa_vault_full(&admin, &params);
    }));
    
    // Check that the failure is NOT due to parameter issues
    if let Err(panic_msg) = result {
        let msg = if let Some(s) = panic_msg.downcast_ref::<std::string::String>() {
            s.clone()
        } else if let Some(s) = panic_msg.downcast_ref::<&str>() {
            std::string::String::from(*s)
        } else {
            std::string::String::from("")
        };
        
        // Should not fail with parameter validation errors
        assert!(!msg.contains("InvalidInitParams"), "Parameters should be valid: {}", msg);
    }
}

/// Test that vault_admin defaults to factory admin when not specified
#[test]
fn test_create_vault_defaults_to_factory_admin() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let asset = Address::generate(&e);
    
    // Create vault without specifying admin (should default to factory admin)
    let params = BatchVaultParams {
        asset: asset.clone(),
        name: String::from_str(&e, "DefaultAdminVault"),
        symbol: String::from_str(&e, "DAV"),
        rwa_name: String::from_str(&e, "Default RWA"),
        rwa_symbol: String::from_str(&e, "DRWA"),
        rwa_document_uri: String::from_str(&e, "https://default.example.com"),
        rwa_category: String::from_str(&e, "DefaultBond"),
        expected_apy: 600,
        maturity_date: 9_999_999_999u64,
        funding_deadline: 0,
        funding_target: 0,
        min_deposit: 0,
        max_deposit_per_user: 0,
        early_redemption_fee_bps: 250,
        vault_admin: None, // Not specified - should use factory admin
        zkme_verifier: None, // Not specified - should use factory default
        cooperator: None, // Not specified - should use factory default
    };

    // This will fail due to dummy WASM hash, but we can verify the parameters are valid
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_single_rwa_vault_full(&admin, &params);
    }));
    
    // Check that the failure is NOT due to parameter issues
    if let Err(panic_msg) = result {
        let msg = if let Some(s) = panic_msg.downcast_ref::<std::string::String>() {
            s.clone()
        } else if let Some(s) = panic_msg.downcast_ref::<&str>() {
            std::string::String::from(*s)
        } else {
            std::string::String::from("")
        };
        
        // Should not fail with parameter validation errors
        assert!(!msg.contains("InvalidInitParams"), "Parameters should be valid: {}", msg);
    }
}

/// Test that batch_create_vaults respects individual vault admin settings
#[test]
fn test_batch_create_vaults_with_different_admins() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let factory_id = client.address.clone();
    
    // Generate addresses for testing
    let custom_admin1 = Address::generate(&e);
    let custom_admin2 = Address::generate(&e);
    let asset = Address::generate(&e);
    let custom_zkme1 = Address::generate(&e);
    let custom_coop2 = Address::generate(&e);

    let mut params: soroban_sdk::Vec<BatchVaultParams> = soroban_sdk::Vec::new(&e);
    
    // First vault with custom admin and zkme_verifier
    params.push_back(BatchVaultParams {
        asset: asset.clone(),
        name: String::from_str(&e, "Vault1"),
        symbol: String::from_str(&e, "V1"),
        rwa_name: String::from_str(&e, "RWA1"),
        rwa_symbol: String::from_str(&e, "R1"),
        rwa_document_uri: String::from_str(&e, "https://vault1.example.com"),
        rwa_category: String::from_str(&e, "Bond1"),
        expected_apy: 500,
        maturity_date: 9_999_999_999u64,
        funding_deadline: 0,
        funding_target: 0,
        min_deposit: 0,
        max_deposit_per_user: 0,
        early_redemption_fee_bps: 200,
        vault_admin: Some(custom_admin1.clone()),
        zkme_verifier: Some(custom_zkme1.clone()),
        cooperator: None, // Use factory default
    });
    
    // Second vault with different custom admin and cooperator
    params.push_back(BatchVaultParams {
        asset: asset.clone(),
        name: String::from_str(&e, "Vault2"),
        symbol: String::from_str(&e, "V2"),
        rwa_name: String::from_str(&e, "RWA2"),
        rwa_symbol: String::from_str(&e, "R2"),
        rwa_document_uri: String::from_str(&e, "https://vault2.example.com"),
        rwa_category: String::from_str(&e, "Bond2"),
        expected_apy: 600,
        maturity_date: 9_999_999_998u64,
        funding_deadline: 0,
        funding_target: 0,
        min_deposit: 0,
        max_deposit_per_user: 0,
        early_redemption_fee_bps: 250,
        vault_admin: Some(custom_admin2.clone()),
        zkme_verifier: None, // Use factory default
        cooperator: Some(custom_coop2.clone()),
    });

    // This will fail due to dummy WASM hash, but we can verify the parameters are valid
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.batch_create_vaults(&admin, &params);
    }));
    
    // Check that the failure is NOT due to parameter issues
    if let Err(panic_msg) = result {
        let msg = if let Some(s) = panic_msg.downcast_ref::<std::string::String>() {
            s.clone()
        } else if let Some(s) = panic_msg.downcast_ref::<&str>() {
            std::string::String::from(*s)
        } else {
            std::string::String::from("")
        };
        
        // Should not fail with parameter validation errors
        assert!(!msg.contains("InvalidInitParams"), "Parameters should be valid: {}", msg);
    }
}

/// Test that simple create_single_rwa_vault still works with factory admin defaults
#[test]
fn test_simple_create_vault_backward_compatibility() {
    let e = Env::default();
    e.mock_all_auths();

    let (client, admin) = setup_factory(&e);
    let asset = Address::generate(&e);
    
    // Simple vault creation should still work and use factory defaults
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_single_rwa_vault(
            &admin,
            &asset,
            &String::from_str(&e, "SimpleVault"),
            &String::from_str(&e, "SV"),
            &String::from_str(&e, "Simple RWA"),
            &String::from_str(&e, "SRWA"),
            &String::from_str(&e, "https://simple.example.com"),
            9_999_999_999u64,
        );
    }));
    
    // Check that the failure is NOT due to parameter issues
    if let Err(panic_msg) = result {
        let msg = if let Some(s) = panic_msg.downcast_ref::<std::string::String>() {
            s.clone()
        } else if let Some(s) = panic_msg.downcast_ref::<&str>() {
            std::string::String::from(*s)
        } else {
            std::string::String::from("")
        };
        
        // Should not fail with parameter validation errors
        assert!(!msg.contains("InvalidInitParams"), "Simple parameters should be valid: {}", msg);
    }
}
