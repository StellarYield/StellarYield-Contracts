extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::{InitParams, SingleRWAVault};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn get_valid_params(e: &Env) -> InitParams {
    InitParams {
        asset: Address::generate(e),
        share_name: String::from_str(e, "Test"),
        share_symbol: String::from_str(e, "T"),
        share_decimals: 6,
        admin: Address::generate(e),
        zkme_verifier: Address::generate(e),
        cooperator: Address::generate(e),
        funding_target: 1000,
        maturity_date: e.ledger().timestamp() + 1000,
        fund_deadline: 0,
        min_deposit: 10,
        max_user_dep: 100,
        redem_fee_bps: 200,
        rwa_name: String::from_str(e, "RWA"),
        rwa_symbol: String::from_str(e, "R"),
        rwa_document_uri: String::from_str(e, "uri"),
        rwa_category: String::from_str(e, "cat"),
        expected_apy: 500,
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
    params.redem_fee_bps = 1001;

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
    params.max_user_dep = 50;

    e.register(SingleRWAVault, (params,));
}
