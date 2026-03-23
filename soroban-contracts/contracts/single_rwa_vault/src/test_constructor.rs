//! Constructor tests for SingleRWAVault.
//!
//! Verifies that every field set in `__constructor` / `InitParams` is correctly
//! persisted and retrievable immediately after deployment.

use crate::test_helpers::setup;
use crate::VaultState;

// ─────────────────────────────────────────────────────────────────────────────
// 1. RWA metadata fields are all retrievable after init
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_rwa_metadata_stored_correctly() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.rwa_name(), ctx.params.rwa_name);
    assert_eq!(v.rwa_symbol(), ctx.params.rwa_symbol);
    assert_eq!(v.rwa_document_uri(), ctx.params.rwa_document_uri);
    assert_eq!(v.rwa_category(), ctx.params.rwa_category);

    let details = v.get_rwa_details();
    assert_eq!(details.name, ctx.params.rwa_name);
    assert_eq!(details.symbol, ctx.params.rwa_symbol);
    assert_eq!(details.document_uri, ctx.params.rwa_document_uri);
    assert_eq!(details.category, ctx.params.rwa_category);
    assert_eq!(details.expected_apy, ctx.params.expected_apy);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Share token metadata matches InitParams
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_share_token_metadata() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.name(), ctx.params.share_name);
    assert_eq!(v.symbol(), ctx.params.share_symbol);
    assert_eq!(v.decimals(), ctx.params.share_decimals);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Admin is set and is also an operator
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_admin_is_set_and_is_operator() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.admin(), ctx.admin);
    assert!(v.is_operator(&ctx.admin), "admin should be an operator by default");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Initial vault state is Funding, paused is false, epoch is 0
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_initial_vault_state() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.vault_state(), VaultState::Funding);
    assert!(!v.paused());
    assert_eq!(v.current_epoch(), 0u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Vault configuration matches InitParams
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_vault_config_matches_init_params() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.funding_target(), ctx.params.funding_target);
    assert_eq!(v.maturity_date(), ctx.params.maturity_date);
    assert_eq!(v.min_deposit(), ctx.params.min_deposit);
    assert_eq!(v.max_deposit_per_user(), ctx.params.max_deposit_per_user);
    assert_eq!(v.early_redemption_fee_bps(), ctx.params.early_redemption_fee_bps);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Total supply and total yield distributed are 0 after init
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_initial_accounting_state_is_zero() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.total_supply(), 0i128);
    assert_eq!(v.total_yield_distributed(), 0i128);
    assert_eq!(v.total_assets(), 0i128);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. KYC verifier and cooperator are stored correctly
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_zkme_verifier_and_cooperator_stored() {
    let ctx = setup();
    let v = &ctx.vault;

    assert_eq!(v.zkme_verifier(), ctx.kyc_id);
    assert_eq!(v.cooperator(), ctx.cooperator);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Asset address is stored correctly
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_asset_address_stored() {
    let ctx = setup();

    assert_eq!(ctx.vault.asset(), ctx.asset_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Expected APY is stored and returned by get_rwa_details
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_expected_apy_stored() {
    let ctx = setup();

    assert_eq!(ctx.vault.expected_apy(), ctx.params.expected_apy);
    assert_eq!(ctx.vault.get_rwa_details().expected_apy, ctx.params.expected_apy);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. time_to_maturity is non-zero (maturity is in the far future)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_time_to_maturity_nonzero_on_init() {
    let ctx = setup();

    // The default maturity_date is 9_999_999_999; ledger starts at ~0 in tests.
    assert!(ctx.vault.time_to_maturity() > 0);
}
