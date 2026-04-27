//! Role-isolation tests for the granular RBAC system (issue #107).
//!
//! Each test verifies that a narrowly-scoped role can perform its permitted
//! operations and is rejected when it tries to call functions outside its scope.

extern crate std;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, String};

use crate::{InitParams, Role, SingleRWAVault, SingleRWAVaultClient};

// ─── Shared helpers ──────────────────────────────────────────────────────────

fn default_params(env: &Env, admin: &Address, asset: &Address) -> InitParams {
    InitParams {
        asset: asset.clone(),
        share_name: String::from_str(env, "Vault Share"),
        share_symbol: String::from_str(env, "VS"),
        share_decimals: 7,
        admin: admin.clone(),
        zkme_verifier: admin.clone(), // vault itself → KYC always true
        cooperator: admin.clone(),
        funding_target: 0_i128, // 0 = no target, activatable immediately
        maturity_date: 9_999_999_999_u64,
        min_deposit: 1_000_i128,
        max_deposit_per_user: 0_i128,
        early_redemption_fee_bps: 0u32,
        operator_fee_bps: 0u32,
        funding_deadline: 0u64,
        rwa_name: String::from_str(env, "Test RWA"),
        rwa_symbol: String::from_str(env, "TRWA"),
        rwa_document_uri: String::from_str(env, "https://test.com"),
        rwa_category: String::from_str(env, "Real Estate"),
        expected_apy: 500_u32,
        timelock_delay: 172800u64, // 48 hours
        yield_vesting_period: 0u64,
    }
}

/// Returns (env, vault_id, asset_id, admin).
fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let asset_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Point zkme_verifier at the vault itself so is_kyc_verified always returns true.
    let vault_id = env.register(SingleRWAVault, (default_params(&env, &admin, &asset_id),));
    SingleRWAVaultClient::new(&env, &vault_id).set_zkme_verifier(&admin, &vault_id);

    (env, vault_id, asset_id, admin)
}

/// Fund `user` with `amount` of the underlying asset.
fn mint_asset(env: &Env, asset_id: &Address, user: &Address, amount: i128) {
    StellarAssetClient::new(env, asset_id).mint(user, &amount);
}

// ─── grant_role / revoke_role ────────────────────────────────────────────────

#[test]
fn test_grant_and_revoke_role() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let addr = Address::generate(&env);

    // Initially the address has no role.
    assert!(!client.has_role(&addr, &Role::YieldOperator));

    client.grant_role(&admin, &addr, &Role::YieldOperator);
    assert!(client.has_role(&addr, &Role::YieldOperator));

    client.revoke_role(&admin, &addr, &Role::YieldOperator);
    assert!(!client.has_role(&addr, &Role::YieldOperator));
}

#[test]
#[should_panic]
fn test_non_admin_cannot_grant_role() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let rando = Address::generate(&env);
    let target = Address::generate(&env);

    // Non-admin trying to grant a role must fail.
    client.grant_role(&rando, &target, &Role::YieldOperator);
}

// ─── has_role — admin always passes ─────────────────────────────────────────

#[test]
fn test_admin_has_every_role() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    assert!(client.has_role(&admin, &Role::YieldOperator));
    assert!(client.has_role(&admin, &Role::LifecycleManager));
    assert!(client.has_role(&admin, &Role::ComplianceOfficer));
    assert!(client.has_role(&admin, &Role::TreasuryManager));
    assert!(client.has_role(&admin, &Role::FullOperator));
}

// ─── FullOperator — backward-compatible superrole ────────────────────────────

#[test]
fn test_full_operator_passes_all_role_checks() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let op = Address::generate(&env);

    client.grant_role(&admin, &op, &Role::FullOperator);

    assert!(client.has_role(&op, &Role::YieldOperator));
    assert!(client.has_role(&op, &Role::LifecycleManager));
    assert!(client.has_role(&op, &Role::ComplianceOfficer));
    assert!(client.has_role(&op, &Role::TreasuryManager));
    assert!(client.has_role(&op, &Role::FullOperator));
}

#[test]
fn test_set_operator_grants_full_operator() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let op = Address::generate(&env);

    // Backward-compat API
    client.set_operator(&admin, &op, &true);
    assert!(client.is_operator(&op));
    assert!(client.has_role(&op, &Role::FullOperator));

    client.set_operator(&admin, &op, &false);
    assert!(!client.is_operator(&op));
    assert!(!client.has_role(&op, &Role::FullOperator));
}

// ─── YieldOperator ───────────────────────────────────────────────────────────

#[test]
fn test_yield_operator_can_distribute_yield() {
    let (env, vault_id, asset_id, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let yield_op = Address::generate(&env);

    client.grant_role(&admin, &yield_op, &Role::YieldOperator);

    // Activate vault so distribute_yield is reachable.
    let lm = Address::generate(&env);
    client.grant_role(&admin, &lm, &Role::LifecycleManager);

    // Deposit first so there are shareholders (Issue #97 fix)
    let depositor = Address::generate(&env);
    mint_asset(&env, &asset_id, &depositor, 10_000_i128);
    client.deposit(&depositor, &10_000_i128, &depositor);

    client.activate_vault(&lm);

    // Give the yield operator enough tokens to inject yield.
    mint_asset(&env, &asset_id, &yield_op, 1_000_000_i128);
    client.distribute_yield(&yield_op, &500_000_i128);
    assert_eq!(client.current_epoch(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #50)")] // NoShareholders error
fn test_distribute_yield_with_no_shareholders_panics() {
    let (env, vault_id, asset_id, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let yield_op = Address::generate(&env);

    client.grant_role(&admin, &yield_op, &Role::YieldOperator);

    // Activate vault without any deposits (Issue #97 test)
    let lm = Address::generate(&env);
    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    client.activate_vault(&lm);

    // Try to distribute yield with no shareholders - should panic
    mint_asset(&env, &asset_id, &yield_op, 1_000_000_i128);
    client.distribute_yield(&yield_op, &500_000_i128);
}

#[test]
#[should_panic]
fn test_yield_operator_cannot_pause() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let yield_op = Address::generate(&env);

    client.grant_role(&admin, &yield_op, &Role::YieldOperator);
    // pause requires TreasuryManager — must panic.
    client.pause(&yield_op, &String::from_str(&env, "test"));
}

#[test]
#[should_panic]
fn test_yield_operator_cannot_activate_vault() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let yield_op = Address::generate(&env);

    client.grant_role(&admin, &yield_op, &Role::YieldOperator);
    // activate_vault requires LifecycleManager — must panic.
    client.activate_vault(&yield_op);
}

// ─── LifecycleManager ────────────────────────────────────────────────────────

#[test]
fn test_lifecycle_manager_can_activate_vault() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let lm = Address::generate(&env);

    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    client.activate_vault(&lm);

    assert_eq!(client.vault_state(), crate::VaultState::Active);
}

#[test]
#[should_panic]
fn test_lifecycle_manager_cannot_distribute_yield() {
    let (env, vault_id, asset_id, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let lm = Address::generate(&env);

    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    client.activate_vault(&lm);

    mint_asset(&env, &asset_id, &lm, 1_000_000_i128);
    // distribute_yield requires YieldOperator — must panic.
    client.distribute_yield(&lm, &500_000_i128);
}

#[test]
#[should_panic]
fn test_lifecycle_manager_cannot_pause() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let lm = Address::generate(&env);

    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    // pause requires TreasuryManager — must panic.
    client.pause(&lm, &String::from_str(&env, "test"));
}

// ─── ComplianceOfficer ───────────────────────────────────────────────────────

#[test]
fn test_compliance_officer_can_set_blacklisted() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let co = Address::generate(&env);
    let target = Address::generate(&env);

    client.grant_role(&admin, &co, &Role::ComplianceOfficer);
    client.set_blacklisted(&co, &target, &true);
    assert!(client.is_blacklisted(&target));
}

#[test]
fn test_compliance_officer_can_set_zkme_verifier() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let co = Address::generate(&env);
    let new_verifier = Address::generate(&env);

    client.grant_role(&admin, &co, &Role::ComplianceOfficer);
    // Should not panic.
    client.set_zkme_verifier(&co, &new_verifier);
}

#[test]
#[should_panic]
fn test_compliance_officer_cannot_set_transfer_exempt() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let co = Address::generate(&env);
    let target = Address::generate(&env);

    client.grant_role(&admin, &co, &Role::ComplianceOfficer);
    client.set_transfer_exempt(&co, &target, &true);
}

#[test]
#[should_panic]
fn test_compliance_officer_cannot_distribute_yield() {
    let (env, vault_id, asset_id, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let co = Address::generate(&env);
    let lm = Address::generate(&env);

    client.grant_role(&admin, &co, &Role::ComplianceOfficer);
    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    client.activate_vault(&lm);

    mint_asset(&env, &asset_id, &co, 1_000_000_i128);
    // distribute_yield requires YieldOperator — must panic.
    client.distribute_yield(&co, &500_000_i128);
}

#[test]
#[should_panic]
fn test_compliance_officer_cannot_activate_vault() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let co = Address::generate(&env);

    client.grant_role(&admin, &co, &Role::ComplianceOfficer);
    // activate_vault requires LifecycleManager — must panic.
    client.activate_vault(&co);
}

// ─── TreasuryManager ─────────────────────────────────────────────────────────

#[test]
fn test_treasury_manager_can_pause() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let tm = Address::generate(&env);

    client.grant_role(&admin, &tm, &Role::TreasuryManager);
    client.pause(&tm, &String::from_str(&env, "security incident"));
    assert!(client.paused());
}

#[test]
#[should_panic]
fn test_treasury_manager_cannot_distribute_yield() {
    let (env, vault_id, asset_id, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let tm = Address::generate(&env);
    let lm = Address::generate(&env);

    client.grant_role(&admin, &tm, &Role::TreasuryManager);
    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    client.activate_vault(&lm);

    mint_asset(&env, &asset_id, &tm, 1_000_000_i128);
    // distribute_yield requires YieldOperator — must panic.
    client.distribute_yield(&tm, &500_000_i128);
}

#[test]
#[should_panic]
fn test_treasury_manager_cannot_activate_vault() {
    let (env, vault_id, _, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let tm = Address::generate(&env);

    client.grant_role(&admin, &tm, &Role::TreasuryManager);
    // activate_vault requires LifecycleManager — must panic.
    client.activate_vault(&tm);
}

// ─── Untrusted address ───────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_random_address_cannot_distribute_yield() {
    let (env, vault_id, asset_id, admin) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let rando = Address::generate(&env);
    let lm = Address::generate(&env);

    client.grant_role(&admin, &lm, &Role::LifecycleManager);
    client.activate_vault(&lm);

    mint_asset(&env, &asset_id, &rando, 1_000_000_i128);
    client.distribute_yield(&rando, &500_000_i128);
}

#[test]
#[should_panic]
fn test_random_address_cannot_pause() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let rando = Address::generate(&env);

    client.pause(&rando, &String::from_str(&env, "attack"));
}
