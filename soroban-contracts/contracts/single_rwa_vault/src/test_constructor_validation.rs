extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{InitParams, SingleRWAVault};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn get_valid_params(e: &Env) -> InitParams {
    InitParams {
            yield_vesting_period: 0,
        asset: Address::generate(e),
        share_name: String::from_str(e, "Test"),
        share_symbol: String::from_str(e, "T"),
        share_decimals: 6,
        admin: Address::generate(e),
        zkme_verifier: Address::generate(e),
        cooperator: Address::generate(e),
        funding_target: 1000,
        maturity_date: e.ledger().timestamp() + 1000,
        funding_deadline: 0,
        min_deposit: 10,
        max_deposit_per_user: 100,
        early_redemption_fee_bps: 200,
        rwa_name: String::from_str(e, "RWA"),
        rwa_symbol: String::from_str(e, "R"),
        rwa_document_uri: String::from_str(e, "uri"),
        rwa_category: String::from_str(e, "cat"),
        expected_apy: 500,
        timelock_delay: 172800u64, // 48 hours
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_constructor_rejects_invalid_decimals() {
    let e = Env::default();
    let mut params = get_valid_params(&e);
    params.share_decimals = 19;

    e.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_constructor_rejects_past_maturity() {
    let e = Env::default();
    let mut params = get_valid_params(&e);
    params.maturity_date = e.ledger().timestamp(); // Current or past not allowed

    e.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_constructor_rejects_high_fee() {
    let e = Env::default();
    let mut params = get_valid_params(&e);
    params.early_redemption_fee_bps = 1001;

    e.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_constructor_rejects_negative_min_deposit() {
    let e = Env::default();
    let mut params = get_valid_params(&e);
    params.min_deposit = -1;

    e.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_constructor_rejects_negative_funding_target() {
    let e = Env::default();
    let mut params = get_valid_params(&e);
    params.funding_target = -1;

    e.register(SingleRWAVault, (params,));
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_constructor_rejects_max_deposit_below_min() {
    let e = Env::default();
    let mut params = get_valid_params(&e);
    params.min_deposit = 100;
    params.max_deposit_per_user = 50;

    e.register(SingleRWAVault, (params,));
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal config (#195)
// ─────────────────────────────────────────────────────────────────────────────

/// A vault initialised with the smallest allowed values for every parameter
/// must deploy without panicking and immediately reflect correct state.
#[test]
fn test_constructor_minimal_config() {
    let e = Env::default();

    // Smallest valid values:
    //   share_decimals       = 0   (minimum; >18 is rejected)
    //   funding_target       = 0   (0 is allowed; negatives are rejected)
    //   min_deposit          = 0   (0 is allowed; negatives are rejected)
    //   max_deposit_per_user = 0   (0 means unlimited; 0 >= min_deposit=0 is valid)
    //   early_redemption_fee_bps = 0   (0 is allowed; >1000 is rejected)
    //   maturity_date        = timestamp + 1  (smallest future value)
    let params = InitParams {
            yield_vesting_period: 0,
        asset: Address::generate(&e),
        share_name: String::from_str(&e, "Min"),
        share_symbol: String::from_str(&e, "M"),
        share_decimals: 0,
        admin: Address::generate(&e),
        zkme_verifier: Address::generate(&e),
        cooperator: Address::generate(&e),
        funding_target: 0,
        maturity_date: e.ledger().timestamp() + 1,
        funding_deadline: 0,
        min_deposit: 0,
        max_deposit_per_user: 0,
        early_redemption_fee_bps: 0,
        rwa_name: String::from_str(&e, "Min RWA"),
        rwa_symbol: String::from_str(&e, "MR"),
        rwa_document_uri: String::from_str(&e, "uri"),
        rwa_category: String::from_str(&e, "cat"),
        expected_apy: 0,
        timelock_delay: 0,
    };

    // Must not panic during registration.
    let vault_id = e.register(SingleRWAVault, (params.clone(),));
    let client = crate::SingleRWAVaultClient::new(&e, &vault_id);

    // Vault initialises in Funding state with zero balances.
    assert_eq!(client.vault_state(), crate::VaultState::Funding);
    assert_eq!(client.total_supply(), 0i128);
    assert_eq!(client.total_assets(), 0i128);
    assert_eq!(client.funding_target(), 0i128);
    assert_eq!(client.min_deposit(), 0i128);
    assert_eq!(client.early_redemption_fee_bps(), 0u32);
    assert_eq!(client.decimals(), 0u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Maximum config (#196)
// ─────────────────────────────────────────────────────────────────────────────

/// A vault initialised with the largest allowed values for every parameter
/// must deploy without overflows or panics and reflect correct state.
#[test]
fn test_constructor_maximum_config() {
    let e = Env::default();

    // Largest valid values:
    //   share_decimals       = 18  (maximum before rejection at 19)
    //   funding_target       = i64::MAX as i128  (large but overflow-safe)
    //   min_deposit          = 1   (non-zero minimum)
    //   max_deposit_per_user = 0   (0 means unlimited)
    //   early_redemption_fee_bps = 1000  (exact maximum; 1001 is rejected)
    //   maturity_date        = u64::MAX / 2  (far future; avoids arithmetic overflow)
    let large_target: i128 = i64::MAX as i128; // ~9.2e18, well within i128 range
    let admin = Address::generate(&e);

    let params = InitParams {
            yield_vesting_period: 0,
        asset: Address::generate(&e),
        share_name: String::from_str(&e, "Maximum Vault Share"),
        share_symbol: String::from_str(&e, "MAXVS"),
        share_decimals: 18,
        admin: admin.clone(),
        zkme_verifier: Address::generate(&e),
        cooperator: Address::generate(&e),
        funding_target: large_target,
        maturity_date: u64::MAX / 2,
        funding_deadline: 0,
        min_deposit: 1,
        max_deposit_per_user: 0,
        early_redemption_fee_bps: 1000,
        rwa_name: String::from_str(&e, "Max RWA Bond"),
        rwa_symbol: String::from_str(&e, "MAXRWA"),
        rwa_document_uri: String::from_str(&e, "https://example.com/max"),
        rwa_category: String::from_str(&e, "Government Bond"),
        expected_apy: u32::MAX,
        timelock_delay: u64::MAX / 2,
    };

    // Must not panic during registration.
    let vault_id = e.register(SingleRWAVault, (params.clone(),));
    let client = crate::SingleRWAVaultClient::new(&e, &vault_id);

    // Vault initialises in Funding state with the stored parameters intact.
    assert_eq!(client.vault_state(), crate::VaultState::Funding);
    assert_eq!(client.total_supply(), 0i128);
    assert_eq!(client.funding_target(), large_target);
    assert_eq!(client.early_redemption_fee_bps(), 1000u32);
    assert_eq!(client.decimals(), 18u32);
    assert_eq!(client.min_deposit(), 1i128);
}
