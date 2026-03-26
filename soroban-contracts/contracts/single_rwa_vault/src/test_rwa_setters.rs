extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token
// ─────────────────────────────────────────────────────────────────────────────

#[soroban_sdk::contract]
pub struct MockToken;

#[soroban_sdk::contractimpl]
impl MockToken {
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&id).unwrap_or(0i128)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_bal: i128 = e.storage().persistent().get(&from).unwrap_or(0);
        if from_bal < amount {
            panic!("insufficient balance");
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

// ─────────────────────────────────────────────────────────────────────────────
// Mock zkMe verifier
// ─────────────────────────────────────────────────────────────────────────────

#[soroban_sdk::contract]
pub struct MockZkme;

#[soroban_sdk::contractimpl]
impl MockZkme {
    pub fn has_approved(e: Env, _cooperator: Address, user: Address) -> bool {
        e.storage().instance().get(&user).unwrap_or(false)
    }

    pub fn approve_user(e: Env, user: Address) {
        e.storage().instance().set(&user, &true);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn make_vault(env: &Env) -> (Address, Address, Address, Address) {
    let admin = Address::generate(env);
    let cooperator = Address::generate(env);
    let token_id = env.register(MockToken, ());
    let zkme_id = env.register(MockZkme, ());

    let vault_id = env.register(
        SingleRWAVault,
        (InitParams {
            asset: token_id.clone(),
            share_name: String::from_str(env, "Test Share"),
            share_symbol: String::from_str(env, "TS"),
            share_decimals: 6u32,
            admin: admin.clone(),
            zkme_verifier: zkme_id.clone(),
            cooperator: cooperator.clone(),
            funding_target: 1_000_000i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 0u64,
            min_deposit: 0i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 200u32,
            rwa_name: String::from_str(env, "Bond A"),
            rwa_symbol: String::from_str(env, "BOND"),
            rwa_document_uri: String::from_str(env, "https://example.com"),
            rwa_category: String::from_str(env, "Bond"),
            expected_apy: 500u32,
        },),
    );

    (vault_id, token_id, zkme_id, admin)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — set_rwa_details (full update)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_rwa_details_updates_all_fields() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let new_name = String::from_str(&e, "Corporate Bond 2027");
    let new_symbol = String::from_str(&e, "CORP27");
    let new_uri = String::from_str(&e, "https://example.com/corp27");
    let new_category = String::from_str(&e, "Corporate Bond");
    let new_apy = 750u32;

    vault.set_rwa_details(
        &admin,
        &new_name,
        &new_symbol,
        &new_uri,
        &new_category,
        &new_apy,
    );

    let details = vault.get_rwa_details();
    assert_eq!(details.name, new_name);
    assert_eq!(details.symbol, new_symbol);
    assert_eq!(details.document_uri, new_uri);
    assert_eq!(details.category, new_category);
    assert_eq!(details.expected_apy, new_apy);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_set_rwa_details_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, _admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let non_admin = Address::generate(&e);

    vault.set_rwa_details(
        &non_admin,
        &String::from_str(&e, "X"),
        &String::from_str(&e, "X"),
        &String::from_str(&e, "X"),
        &String::from_str(&e, "X"),
        &100u32,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — set_rwa_document_uri
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_rwa_document_uri_updates_only_uri() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let original = vault.get_rwa_details();
    let new_uri = String::from_str(&e, "https://new-docs.example.com/bond");

    vault.set_rwa_document_uri(&admin, &new_uri);

    let updated = vault.get_rwa_details();
    assert_eq!(updated.document_uri, new_uri);
    // Other fields unchanged
    assert_eq!(updated.name, original.name);
    assert_eq!(updated.symbol, original.symbol);
    assert_eq!(updated.category, original.category);
    assert_eq!(updated.expected_apy, original.expected_apy);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_set_rwa_document_uri_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, _admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let non_admin = Address::generate(&e);

    vault.set_rwa_document_uri(&non_admin, &String::from_str(&e, "https://evil.com"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — set_expected_apy
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_expected_apy_updates_only_apy() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let original = vault.get_rwa_details();
    let new_apy = 1200u32; // 12%

    vault.set_expected_apy(&admin, &new_apy);

    let updated = vault.get_rwa_details();
    assert_eq!(updated.expected_apy, new_apy);
    // Other fields unchanged
    assert_eq!(updated.name, original.name);
    assert_eq!(updated.symbol, original.symbol);
    assert_eq!(updated.document_uri, original.document_uri);
    assert_eq!(updated.category, original.category);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_set_expected_apy_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, _admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let non_admin = Address::generate(&e);

    vault.set_expected_apy(&non_admin, &999u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — get_rwa_details reflects updated values after sequential changes
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_get_rwa_details_reflects_sequential_updates() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    // First update via set_expected_apy
    vault.set_expected_apy(&admin, &800u32);
    assert_eq!(vault.get_rwa_details().expected_apy, 800);

    // Then update via set_rwa_document_uri
    let uri = String::from_str(&e, "https://updated.example.com");
    vault.set_rwa_document_uri(&admin, &uri);
    let details = vault.get_rwa_details();
    assert_eq!(details.document_uri, uri);
    assert_eq!(details.expected_apy, 800); // still 800 from previous update

    // Full update overwrites everything
    vault.set_rwa_details(
        &admin,
        &String::from_str(&e, "New Name"),
        &String::from_str(&e, "NEW"),
        &String::from_str(&e, "https://final.example.com"),
        &String::from_str(&e, "Equity"),
        &300u32,
    );
    let final_details = vault.get_rwa_details();
    assert_eq!(final_details.name, String::from_str(&e, "New Name"));
    assert_eq!(final_details.symbol, String::from_str(&e, "NEW"));
    assert_eq!(
        final_details.document_uri,
        String::from_str(&e, "https://final.example.com")
    );
    assert_eq!(final_details.category, String::from_str(&e, "Equity"));
    assert_eq!(final_details.expected_apy, 300);
}
