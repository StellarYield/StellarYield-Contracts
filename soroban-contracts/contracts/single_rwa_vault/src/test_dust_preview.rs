//! Tests for the dust-rounding guards on preview_deposit (#47) and
//! preview_redeem (#48) — issue #1364.
//!
//! When vault price drift causes the rounded share/asset amount to be zero
//! the functions must panic instead of silently succeeding.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass};

// VIRTUAL_OFFSET = 1_000_000 (see lib.rs constant).
// For preview_deposit(1) to round to 0 shares:
//   floor(1 * (supply + 1M) / (ta + 1M)) == 0
//   → ta + 1M > supply + 1M  → ta > supply
//   With supply=0 and ta=2_000_000: floor(1M / 3M) = 0  ✓

/// preview_deposit panics PreviewZeroShares (#47) when total_assets so far
/// exceeds VIRTUAL_OFFSET so that depositing 1 unit rounds to 0 shares.
#[test]
#[should_panic(expected = "Error(Contract, #47)")]
fn test_preview_deposit_dust_panics_zero_shares() {
    let ctx = setup_with_kyc_bypass();

    // Mint 2_000_000 tokens directly to the vault address without depositing.
    // supply stays 0, ta = 2_000_000.
    // floor(1 * (0 + 1_000_000) / (2_000_000 + 1_000_000)) = floor(1M/3M) = 0 → panic.
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.vault_id, 2_000_000);

    ctx.vault().preview_deposit(&1);
}

// For preview_redeem(1) to round to 0 assets:
//   floor(1 * (ta + 1M) / (supply + 1M)) == 0
//   → ta + 1M < supply + 1M → ta < supply
//   With supply=1, ta=0: floor(1M / (1 + 1M)) = floor(1M/1_000_001) = 0  ✓

/// preview_redeem panics PreviewZeroAssets (#48) when supply > 0 but the
/// vault holds no assets, so redeeming 1 share rounds to 0 assets.
#[test]
#[should_panic(expected = "Error(Contract, #48)")]
fn test_preview_redeem_dust_panics_zero_assets() {
    let ctx = setup_with_kyc_bypass();

    // Deposit 1 unit so supply = 1, ta = 1.
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1);
    ctx.vault().deposit(&ctx.user, &1, &ctx.user);

    // Transfer the 1 unit back out of the vault via the asset mock so that
    // ta drops to 0 while supply=1 remains (mock_all_auths allows this).
    ctx.asset().transfer(&ctx.vault_id, &ctx.user, &1);

    // floor(1 * (0 + 1_000_000) / (1 + 1_000_000)) = floor(1M/1_000_001) = 0 → panic.
    ctx.vault().preview_redeem(&1);
}

/// Sanity: preview_deposit succeeds when shares > 0.
#[test]
fn test_preview_deposit_normal_succeeds() {
    let ctx = setup_with_kyc_bypass();
    // Empty vault — 1:1 conversion by virtual offset, no inflation.
    let shares = ctx.vault().preview_deposit(&1_000_000);
    assert_eq!(shares, 1_000_000);
}

/// Sanity: preview_redeem succeeds when assets > 0.
#[test]
fn test_preview_redeem_normal_succeeds() {
    let ctx = setup_with_kyc_bypass();
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1_000_000);
    ctx.vault().deposit(&ctx.user, &1_000_000, &ctx.user);

    // With supply=1M and ta=1M the redeem rate is 1:1.
    let assets = ctx.vault().preview_redeem(&1_000_000);
    assert_eq!(assets, 1_000_000);
}
