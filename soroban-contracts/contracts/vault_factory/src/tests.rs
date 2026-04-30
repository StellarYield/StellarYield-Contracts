extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, BytesN, Env, IntoVal, String,
};

use crate::{
    storage::{
        get_vault_count, get_vault_info, increment_vault_deploy_counter, put_vault_by_deploy_id,
        put_vault_info, register_vault,
    },
    types::{VaultInfo, VaultType},
    VaultFactory, VaultFactoryClient,
};

use single_rwa_vault::SingleRWAVaultClient;

// ─────────────────────────────────────────────────────────────────────────────
// Test Context
// ─────────────────────────────────────────────────────────────────────────────

// Unused test context - kept for potential future use
#[allow(dead_code)]
pub struct TestContext {
    pub env: Env,
    pub factory_id: Address,
    pub admin: Address,
    pub asset_id: Address,
}

#[allow(dead_code)]
impl TestContext {
    pub fn factory(&self) -> VaultFactoryClient<'_> {
        VaultFactoryClient::new(&self.env, &self.factory_id)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Deploy and initialise a VaultFactory with a dummy WASM hash.
pub fn setup_factory(e: &Env) -> (Address, Address) {
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
    (factory_id, admin)
}

/// Setup a test context with factory and necessary addresses.
#[allow(dead_code)]
pub fn setup_test_context() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();
    let (factory_id, admin) = setup_factory(&env);
    let asset_id = Address::generate(&env);

    TestContext {
        env,
        factory_id,
        admin,
        asset_id,
    }
}

#[allow(dead_code)]
fn create_default_vault(ctx: &TestContext) -> (Address, SingleRWAVaultClient<'_>) {
    let factory = ctx.factory();

    // Use a future maturity date
    let maturity = ctx.env.ledger().timestamp() + 1_000_000;

    let vault_addr = factory.create_single_rwa_vault(
        &ctx.admin,
        &ctx.asset_id,
        &soroban_sdk::String::from_str(&ctx.env, "Test Vault"),
        &soroban_sdk::String::from_str(&ctx.env, "TVLT"),
        &soroban_sdk::String::from_str(&ctx.env, "Test RWA"),
        &soroban_sdk::String::from_str(&ctx.env, "TRWA"),
        &soroban_sdk::String::from_str(&ctx.env, "ipfs://test"),
        &maturity,
    );

    let vault_client = SingleRWAVaultClient::new(&ctx.env, &vault_addr);

    (vault_addr, vault_client)
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
        register_vault(e, vault.clone());
    });

    vault
}

fn inject_vault_with_deploy_id(e: &Env, factory_id: &Address, active: bool) -> Address {
    let vault = inject_vault(e, factory_id, active);
    e.as_contract(factory_id, || {
        let id = increment_vault_deploy_counter(e);
        put_vault_by_deploy_id(e, id, &vault);
    });
    vault
}

/// `VaultInfo.asset` is stored in the registry and returned by `get_vault_info` so
/// indexers can resolve the underlying asset without N+1 vault calls.
#[test]
fn test_get_vault_info_includes_underlying_asset() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let vault = Address::generate(&e);
    let asset = Address::generate(&e);
    let info = VaultInfo {
        vault: vault.clone(),
        asset: asset.clone(),
        vault_type: VaultType::SingleRwa,
        name: String::from_str(&e, "Asset Test"),
        symbol: String::from_str(&e, "AT"),
        active: true,
        created_at: e.ledger().timestamp(),
    };

    e.as_contract(&factory_id, || {
        put_vault_info(&e, &vault, info);
    });

    let got = client.get_vault_info(&vault).unwrap();
    assert_eq!(got.asset, asset);
    assert_eq!(got.vault, vault);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// ─── Empty registry (#170) ───────────────────────────────────────────────────

/// get_all_vaults returns an empty vec when no vaults have been created yet.
#[test]
fn test_get_all_vaults_returns_empty_when_no_vaults() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let all = client.get_all_vaults();
    assert_eq!(
        all.len(),
        0,
        "get_all_vaults must return an empty vec when the registry is empty"
    );
}

/// get_active_vaults returns an empty vec when no vaults have been created yet.
#[test]
fn test_get_active_vaults_returns_empty_when_no_vaults() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let active = client.get_active_vaults();
    assert_eq!(
        active.len(),
        0,
        "get_active_vaults must return an empty vec when the registry is empty"
    );
}

/// get_vault_count returns 0 when no vaults have been created yet.
#[test]
fn test_get_vault_count_is_zero_when_no_vaults() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    assert_eq!(
        client.get_vault_count(),
        0u32,
        "vault count must be 0 when no vaults exist"
    );
}

/// get_vaults_paginated returns an empty vec when the registry is empty.
#[test]
fn test_get_vaults_paginated_returns_empty_when_no_vaults() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let page = client.get_vaults_paginated(&0, &10);
    assert_eq!(
        page.len(),
        0,
        "get_vaults_paginated must return an empty vec when the registry is empty"
    );
}

/// get_active_vaults_paginated returns an empty vec when the registry is empty.
#[test]
fn test_get_active_vaults_paginated_returns_empty_when_no_vaults() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let page = client.get_active_vaults_paginated(&0, &10);
    assert_eq!(
        page.len(),
        0,
        "get_active_vaults_paginated must return an empty vec when the registry is empty"
    );
}

// ─── ActiveVaults list ────────────────────────────────────────────────────────

/// set_vault_status keeps ActiveVaults in sync: deactivating removes,
/// reactivating re-adds.
#[test]
fn test_set_vault_status_updates_active_list() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let vault = inject_vault(&e, &factory_id, true);

    // Initially active — should appear in ActiveVaults.
    assert!(client.get_active_vaults().contains(vault.clone()));

    // Deactivate — must be removed from ActiveVaults.
    client.set_vault_status(&admin, &vault, &false);
    assert!(!client.get_active_vaults().contains(vault.clone()));

    // Reactivate — must be re-added.
    client.set_vault_status(&admin, &vault, &true);
    assert!(client.get_active_vaults().contains(vault.clone()));
}

/// get_active_vaults returns only the active list directly (O(1) read).
#[test]
fn test_get_active_vaults_uses_dedicated_list() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    for _ in 0..5 {
        inject_vault(&e, &factory_id, true);
    }

    let all = client.get_all_vaults();
    e.as_contract(&factory_id, || {
        assert_eq!(get_vault_count(&e) as usize, all.len() as usize);
    });
}

/// Offset past the end of the active list returns an empty vec (#186).
#[test]
fn test_get_active_vaults_offset_out_of_range() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    // Create 3 active vaults
    inject_vault(&e, &factory_id, true);
    inject_vault(&e, &factory_id, true);
    inject_vault(&e, &factory_id, true);

    // Call with large offset
    let page = client.get_active_vaults_paginated(&10, &5);
    assert_eq!(
        page.len(),
        0,
        "get_active_vaults_paginated must return empty vec for out-of-range offset"
    );
}

// ─── get_vaults_paginated ─────────────────────────────────────────────────────

/// First page returns up to `limit` items starting at offset 0.
#[test]
fn test_get_vaults_paginated_first_page() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let vault = inject_vault(&e, &factory_id, false /* inactive */);

    // Pre-conditions
    let all_pre = client.get_all_vaults();
    let single_pre = client.get_single_rwa_vaults();
    e.as_contract(&factory_id, || {
        assert!(get_vault_info(&e, &vault).is_some());
        assert!(all_pre.contains(vault.clone()));
        assert!(single_pre.contains(vault.clone()));
    });

    client.remove_vault(&admin, &vault);

    // Post-conditions: vault purged from all lists and VaultInfo deleted
    let all_post = client.get_all_vaults();
    let single_post = client.get_single_rwa_vaults();
    e.as_contract(&factory_id, || {
        assert!(
            get_vault_info(&e, &vault).is_none(),
            "VaultInfo must be deleted"
        );
        assert!(
            !all_post.contains(vault.clone()),
            "vault must not appear in AllVaults"
        );
        assert!(
            !single_post.contains(vault.clone()),
            "vault must not appear in SingleRwaVaults"
        );
    });
}

/// get_all_vaults no longer returns the removed vault.
#[test]
fn test_get_all_vaults_excludes_removed_vault() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

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

    let (factory_id, _admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
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

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
    let vault = inject_vault(&e, &factory_id, true /* active */);

    client.remove_vault(&admin, &vault);
}

/// Attempting to remove a vault that does not exist must fail with VaultNotFound.
#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_remove_unknown_vault_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
    let ghost = Address::generate(&e);

    client.remove_vault(&admin, &ghost);
}

/// VaultRemoved event is emitted on a successful removal.
#[test]
fn test_remove_vault_emits_event() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
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

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
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

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
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

// ─────────────────────────────────────────────────────────────────────────────
// #208 — View functions on non-existent vault addresses
//
// Calling view functions for a vault that is not registered should have
// well-defined behavior (error or empty response). This test confirms the
// current behavior for non-existent vault addresses.
// ─────────────────────────────────────────────────────────────────────────────

/// Test view functions behavior when called with non-existent vault addresses.
///
/// Current behavior:
/// - get_vault_info() returns None for non-existent vaults
/// - is_registered_vault() returns false for non-existent vaults
/// - set_vault_status() panics with VaultNotFound error for non-existent vaults
#[test]
fn test_view_functions_non_existent_vault() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
    let _factory_id = factory_id;

    // Generate a vault address that is not registered
    let non_existent_vault = Address::generate(&e);

    // Test get_vault_info returns None for non-existent vault
    let vault_info = client.get_vault_info(&non_existent_vault);
    assert!(
        vault_info.is_none(),
        "get_vault_info should return None for non-existent vault"
    );

    // Test is_registered_vault returns false for non-existent vault
    let is_registered = client.is_registered_vault(&non_existent_vault);
    assert!(
        !is_registered,
        "is_registered_vault should return false for non-existent vault"
    );

    // Test set_vault_status panics with VaultNotFound for non-existent vault
    // This is an admin function, not a view function, but it's included to show
    // the complete behavior for non-existent vault addresses
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_vault_status(&admin, &non_existent_vault, &false);
    }));

    assert!(
        result.is_err(),
        "set_vault_status should panic for non-existent vault"
    );

    // Verify the panic message contains the expected error code
    if let Err(panic_payload) = result {
        let panic_msg = if let Some(s) = panic_payload.downcast_ref::<std::string::String>() {
            s.clone()
        } else if let Some(s) = panic_payload.downcast_ref::<&str>() {
            std::string::String::from(*s)
        } else {
            std::string::String::from("")
        };

        // The error code for VaultNotFound is #2 based on the existing tests
        assert!(
            panic_msg.contains("#2") || panic_msg.contains("VaultNotFound"),
            "set_vault_status should panic with VaultNotFound error for non-existent vault"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// #214 — Forward-looking: mixed vault types (SingleRwa + Aggregator)
//
// The Aggregator vault type is already declared in VaultType but not yet
// deployable through the factory.  This test documents the *desired* registry
// behaviour once Aggregator vaults are supported:
//
//   • get_all_vaults()    → returns every vault regardless of type
//   • get_active_vaults() → returns every active vault regardless of type
//   • get_single_rwa_vaults() — SingleRwa list must NOT include Aggregator entries
//
// The test is marked #[ignore] so it does not block CI until the Aggregator
// vault type is fully implemented.  Remove the #[ignore] attribute and fill in
// the deployment call once create_aggregator_vault (or equivalent) is added to
// the factory.
// ─────────────────────────────────────────────────────────────────────────────

/// Forward-looking test: registry correctly separates SingleRwa and Aggregator
/// vault types when both exist side-by-side.
///
/// Marked #[ignore] — Aggregator deployment is not yet implemented in the
/// factory.  This test serves as a specification stub that compiles cleanly and
/// will be activated once the feature lands.
#[test]
#[ignore]
fn test_mixed_vault_types_registry_filtering() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    // Inject a SingleRwa vault directly (active).
    let single_rwa_vault = inject_vault(&e, &factory_id, true);

    // Inject a stub Aggregator vault entry directly into the registry.
    // Replace this with a real factory call once aggregator deployment exists.
    let aggregator_vault = Address::generate(&e);
    let aggregator_info = crate::types::VaultInfo {
        vault: aggregator_vault.clone(),
        asset: Address::generate(&e),
        vault_type: crate::types::VaultType::Aggregator,
        name: String::from_str(&e, "Aggregator Vault"),
        symbol: String::from_str(&e, "AGG"),
        active: true,
        created_at: e.ledger().timestamp(),
    };
    e.as_contract(&factory_id, || {
        put_vault_info(&e, &aggregator_vault, aggregator_info);
        register_vault(&e, aggregator_vault.clone());
    });

    // ── get_all_vaults returns both types ─────────────────────────────────────
    let all = client.get_all_vaults();
    assert_eq!(all.len(), 2, "get_all_vaults must return both vault types");
    assert!(
        all.contains(single_rwa_vault.clone()),
        "all vaults must include SingleRwa vault"
    );
    assert!(
        all.contains(aggregator_vault.clone()),
        "all vaults must include Aggregator vault"
    );

    // ── get_active_vaults returns both active entries ─────────────────────────
    let active = client.get_active_vaults();
    assert_eq!(
        active.len(),
        2,
        "get_active_vaults must return all active vaults"
    );

    // ── SingleRwa-specific list must not include the Aggregator vault ─────────
    let single_rwa_list = client.get_single_rwa_vaults();
    assert!(
        single_rwa_list.contains(single_rwa_vault.clone()),
        "SingleRwaVaults list must contain the SingleRwa vault"
    );
    assert!(
        !single_rwa_list.contains(aggregator_vault.clone()),
        "SingleRwaVaults list must NOT contain the Aggregator vault"
    );

    // ── VaultInfo.vault_type discriminates correctly ───────────────────────────
    let single_info = client
        .get_vault_info(&single_rwa_vault)
        .expect("SingleRwa VaultInfo must exist");
    assert_eq!(single_info.vault_type, crate::types::VaultType::SingleRwa);

    let agg_info = client
        .get_vault_info(&aggregator_vault)
        .expect("Aggregator VaultInfo must exist");
    assert_eq!(agg_info.vault_type, crate::types::VaultType::Aggregator);
}

// ─── Vault Ordering ───────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// #157 — Pagination over exact multiples of page size
// ─────────────────────────────────────────────────────────────────────────────

/// When the total vault count is exactly 2× the page size (20 vaults, page 10),
/// the first page must be full and the second page must be exactly the remainder
/// — no duplicates, no omissions.
#[test]
fn test_get_vaults_paginated_exact_double_page_size() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let page_size: u32 = 10;
    let total: u32 = page_size * 2; // exactly 20

    let mut all_vaults = soroban_sdk::Vec::new(&e);
    for _ in 0..total {
        all_vaults.push_back(inject_vault(&e, &factory_id, true));
    }

    let page1 = client.get_vaults_paginated(&0, &page_size);
    assert_eq!(
        page1.len(),
        page_size,
        "first page must be exactly page_size items"
    );

    let page2 = client.get_vaults_paginated(&page_size, &page_size);
    assert_eq!(
        page2.len(),
        page_size,
        "second page must be exactly page_size items (no omissions)"
    );

    // No duplicates: union of both pages must equal the full vault list.
    for i in 0..page_size {
        assert_eq!(
            page1.get(i).unwrap(),
            all_vaults.get(i).unwrap(),
            "page1[{i}] mismatch"
        );
        assert_eq!(
            page2.get(i).unwrap(),
            all_vaults.get(page_size + i).unwrap(),
            "page2[{i}] mismatch"
        );
    }
}

/// When the total vault count is exactly 3× the page size (30 vaults, page 10),
/// all three pages must each return exactly page_size items with no gaps.
#[test]
fn test_get_vaults_paginated_exact_triple_page_size() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let page_size: u32 = 10;
    let total: u32 = page_size * 3; // exactly 30

    let mut all_vaults = soroban_sdk::Vec::new(&e);
    for _ in 0..total {
        all_vaults.push_back(inject_vault(&e, &factory_id, true));
    }

    for page_idx in 0u32..3 {
        let offset = page_idx * page_size;
        let page = client.get_vaults_paginated(&offset, &page_size);
        assert_eq!(
            page.len(),
            page_size,
            "page {page_idx} must return exactly {page_size} items"
        );
        for i in 0..page_size {
            assert_eq!(
                page.get(i).unwrap(),
                all_vaults.get(offset + i).unwrap(),
                "page {page_idx} item {i} mismatch"
            );
        }
    }

    // Page after the last item returns empty.
    let beyond = client.get_vaults_paginated(&total, &page_size);
    assert_eq!(beyond.len(), 0, "page beyond the last item must be empty");
}

/// Exact-multiple test for active-only pagination: 20 active vaults, page 10.
#[test]
fn test_get_active_vaults_paginated_exact_double_page_size() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let page_size: u32 = 10;
    let total: u32 = page_size * 2;

    let mut active_vaults = soroban_sdk::Vec::new(&e);
    for _ in 0..total {
        active_vaults.push_back(inject_vault(&e, &factory_id, true));
    }

    let page1 = client.get_active_vaults_paginated(&0, &page_size);
    assert_eq!(page1.len(), page_size, "first active page must be full");

    let page2 = client.get_active_vaults_paginated(&page_size, &page_size);
    assert_eq!(
        page2.len(),
        page_size,
        "second active page must be full (no omissions)"
    );

    for i in 0..page_size {
        assert_eq!(page1.get(i).unwrap(), active_vaults.get(i).unwrap());
        assert_eq!(
            page2.get(i).unwrap(),
            active_vaults.get(page_size + i).unwrap()
        );
    }

    // No additional items beyond page 2.
    let empty = client.get_active_vaults_paginated(&total, &page_size);
    assert_eq!(empty.len(), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// #156 — Default vault params sanity check
// ─────────────────────────────────────────────────────────────────────────────

/// Calling set_defaults stores asset, zkme_verifier, and cooperator, which are
/// immediately readable via the corresponding view functions.  This is the
/// canonical path for verifying that factory defaults are wired through
/// correctly before creating vaults with them.
#[test]
fn test_default_vault_params_stored_and_readable() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let new_asset = Address::generate(&e);
    let new_zkme = Address::generate(&e);
    let new_coop = Address::generate(&e);

    client.set_defaults(&admin, &new_asset, &new_zkme, &new_coop);

    assert_eq!(
        client.default_asset(),
        new_asset,
        "default_asset must reflect the value passed to set_defaults"
    );
    assert_eq!(
        client.default_zkme_verifier(),
        new_zkme,
        "default_zkme_verifier must reflect the value passed to set_defaults"
    );
    assert_eq!(
        client.default_cooperator(),
        new_coop,
        "default_cooperator must reflect the value passed to set_defaults"
    );
}

/// Overwriting defaults with a second set_defaults call replaces the previous
/// values — there is no stale carry-over from the first call.
#[test]
fn test_default_vault_params_overwrite_previous() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let asset_v1 = Address::generate(&e);
    let zkme_v1 = Address::generate(&e);
    let coop_v1 = Address::generate(&e);
    client.set_defaults(&admin, &asset_v1, &zkme_v1, &coop_v1);

    let asset_v2 = Address::generate(&e);
    let zkme_v2 = Address::generate(&e);
    let coop_v2 = Address::generate(&e);
    client.set_defaults(&admin, &asset_v2, &zkme_v2, &coop_v2);

    assert_eq!(client.default_asset(), asset_v2);
    assert_eq!(client.default_zkme_verifier(), zkme_v2);
    assert_eq!(client.default_cooperator(), coop_v2);
}

/// Non-admin callers must not be able to update defaults.
#[test]
#[should_panic]
fn test_set_defaults_non_admin_rejected() {
    let e = Env::default();
    e.mock_all_auths();

    let (factory_id, _admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);
    let attacker = Address::generate(&e);

    // Disable the blanket mock so auth is actually enforced.
    // Re-register without mock_all_auths isn't straightforward in the test
    // harness, so we rely on the contract's require_admin check panicking
    // when called by a non-admin address.
    client.set_defaults(
        &attacker,
        &Address::generate(&e),
        &Address::generate(&e),
        &Address::generate(&e),
    );
}

/// get_all_vaults returns vaults in the order they were created.
#[test]
fn test_get_all_vaults_returns_vaults_in_creation_order() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    // Inject vaults in a known order
    let v1 = inject_vault(&e, &factory_id, true);
    let v2 = inject_vault(&e, &factory_id, true);
    let v3 = inject_vault(&e, &factory_id, true);
    let v4 = inject_vault(&e, &factory_id, true);

    // Get all vaults
    let all_vaults = client.get_all_vaults();

    // Verify count
    assert_eq!(all_vaults.len(), 4);

    // Verify order matches creation order
    assert_eq!(all_vaults.get(0).unwrap(), v1);
    assert_eq!(all_vaults.get(1).unwrap(), v2);
    assert_eq!(all_vaults.get(2).unwrap(), v3);
    assert_eq!(all_vaults.get(3).unwrap(), v4);

    // Verify vault count matches
    assert_eq!(client.get_vault_count(), 4);
}

#[test]
fn test_list_recent_vaults_returns_newest_first() {
    let e = Env::default();
    e.mock_all_auths();
    let (factory_id, _admin) = setup_factory(&e);
    let client = VaultFactoryClient::new(&e, &factory_id);

    let v1 = inject_vault_with_deploy_id(&e, &factory_id, true);
    let v2 = inject_vault_with_deploy_id(&e, &factory_id, true);
    let v3 = inject_vault_with_deploy_id(&e, &factory_id, true);
    let v4 = inject_vault_with_deploy_id(&e, &factory_id, true);
    let v5 = inject_vault_with_deploy_id(&e, &factory_id, true);

    let recent = client.list_recent_vaults(&3);
    assert_eq!(recent.len(), 3);
    assert_eq!(recent.get(0).unwrap(), v5);
    assert_eq!(recent.get(1).unwrap(), v4);
    assert_eq!(recent.get(2).unwrap(), v3);

    // Asking for more than exist returns all (up to cap).
    let all_recent = client.list_recent_vaults(&10);
    assert_eq!(all_recent.len(), 5);
    assert_eq!(all_recent.get(4).unwrap(), v1);
    assert_eq!(all_recent.get(0).unwrap(), v5);
    assert_eq!(all_recent.get(1).unwrap(), v4);
    assert_eq!(all_recent.get(2).unwrap(), v3);
    assert_eq!(all_recent.get(3).unwrap(), v2);
}
