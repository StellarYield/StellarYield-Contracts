//! Tests for the monitoring/dashboard views: `get_vault_health`,
//! `is_funding_open`, `funding_progress_bps`, `share_price_bps`, and
//! `set_max_investors`.
//!
//! ## `get_vault_health` states & thresholds (#1348)
//!
//! `get_vault_health` returns a raw snapshot; dashboards derive health from:
//! - `share_price`: `0` when `total_supply == 0` **or** `total_assets <= 0`;
//!   otherwise `floor(total_assets * PRECISION / total_supply)` with
//!   `PRECISION = 1_000_000`.
//! - `funding_progress`: `0` when `funding_target <= 0` **or**
//!   `total_assets <= 0`; otherwise `clamp(floor(total_assets * 10_000 /
//!   funding_target), 0, 10_000)`.
//! - `investor_count`: `lifetime.new_investors - lifetime.exiting_investors`
//!   (saturating at 0).
//! - `state`, `paused`, `time_to_maturity`: pass-through storage reads.
//!
//! Reachable health states exercised below: empty/unfunded vault, funding
//! below target, funding at/above target (progress clamped at 10_000), and
//! paused vault.
//!
//! ## `is_funding_open` / `funding_progress_bps` thresholds (#1349)
//!
//! - `funding_progress_bps = clamp(floor(total_assets * 10_000 /
//!   funding_target), 0, 10_000)`; `0` when target or assets are `<= 0`.
//! - `is_funding_open` is `true` iff vault state is `Funding` or `Active`,
//!   the vault is not paused, and `FREEZE_DEPOSIT_MINT` is unset. It does
//!   **not** consult the funding target: at/above target the vault still
//!   reports "open" while in `Funding`; the deposit path itself rejects
//!   over-target funding deposits with `Error::FundingTargetExceeded` (#46).
//!   `is_funding_open` flips to `false` on pause, freeze, or a non-funding
//!   state — the same conditions that make `deposit`/`mint` revert.
//!
//! ## `share_price_bps` rounding (#1350)
//!
//! `share_price_bps = floor(total_assets * 10_000 / total_supply)` when
//! `total_supply > 0` and `total_assets > 0`. Returns `10_000` (par) when
//! `total_supply == 0` and `0` when `total_assets <= 0`. Rounding is
//! **floor (rounds down)** via `math::mul_div` — documented on the method.
//!
//! ## `set_max_investors` (#1351)
//!
//! Admin-only setter (`require_admin`); `0` means unlimited. The cap is
//! enforced for *new* investors inside `deposit`/`mint` with
//! `Error::MaxInvestorsReached` (#53). Setting a cap below the current
//! investor count is permitted — it only blocks future new investors.

use crate::test_helpers::*;
use crate::VaultState;
use soroban_sdk::{testutils::Address as _, Address, String};

// ─────────────────────────────────────────────────────────────────────────────
// #1348 — get_vault_health
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_health_empty_vault() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    let health = vault.get_vault_health();

    // Empty vault: no supply/assets → share_price reported as 0 (par is only
    // implied by share_price_bps), funding progress 0, no investors.
    assert_eq!(health.state, VaultState::Funding);
    assert!(!health.paused);
    assert_eq!(health.total_supply, 0);
    assert_eq!(health.total_assets, 0);
    assert_eq!(health.share_price, 0);
    assert_eq!(health.funding_progress, 0);
    assert_eq!(health.investor_count, 0);
}

#[test]
fn test_health_below_funding_target() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);

    // 50% of the 100_000_000 funding target.
    vault.deposit(&user, &50_000_000, &user);

    let health = vault.get_vault_health();
    assert_eq!(health.state, VaultState::Funding);
    assert_eq!(health.total_assets, 50_000_000);
    // First deposit mints shares 1:1 → par share price (PRECISION = 1e6).
    assert_eq!(health.share_price, 1_000_000);
    // floor(50_000_000 * 10_000 / 100_000_000) = 5_000 bps.
    assert_eq!(health.funding_progress, 5_000);
    assert_eq!(health.investor_count, 1);
}

#[test]
fn test_health_at_and_above_funding_target() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 300_000_000);

    vault.deposit(&user, &100_000_000, &user);
    assert_eq!(vault.get_vault_health().funding_progress, 10_000);

    vault.activate_vault(&ctx.admin);

    // Post-activation deposits are uncapped; progress stays clamped at 10_000.
    vault.deposit(&user, &50_000_000, &user);

    let health = vault.get_vault_health();
    assert_eq!(health.state, VaultState::Active);
    assert_eq!(health.total_assets, 150_000_000);
    assert_eq!(health.funding_progress, 10_000);
    assert_eq!(health.investor_count, 1);
}

#[test]
fn test_health_paused_vault() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);
    vault.deposit(&user, &50_000_000, &user);

    vault.pause(&ctx.admin, &String::from_str(&ctx.env, "maintenance"));

    let health = vault.get_vault_health();
    assert!(health.paused);
    assert_eq!(health.state, VaultState::Funding);
    // Snapshot fields are still reported while paused.
    assert_eq!(health.total_assets, 50_000_000);
    assert_eq!(health.funding_progress, 5_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1349 — is_funding_open / funding_progress_bps at the funding target
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_funding_progress_zero_when_unfunded() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    // total_assets == 0 → progress 0 even though a target is configured.
    assert_eq!(vault.funding_progress_bps(), 0);
    assert!(vault.is_funding_open());
}

#[test]
fn test_funding_progress_below_target() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);

    // 50% of target → 5_000 bps.
    vault.deposit(&user, &50_000_000, &user);
    assert_eq!(vault.funding_progress_bps(), 5_000);
    assert!(vault.is_funding_open());

    // Just below target: 99_999_999 / 100_000_000 → floor(9_999.9999) = 9_999.
    vault.deposit(&user, &49_999_999, &user);
    assert_eq!(vault.funding_progress_bps(), 9_999);
    assert!(vault.is_funding_open());
}

#[test]
fn test_funding_progress_at_target() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);

    // Exactly the target: floor(100_000_000 * 10_000 / 100_000_000) = 10_000.
    vault.deposit(&user, &100_000_000, &user);
    assert_eq!(vault.funding_progress_bps(), 10_000);
    // `is_funding_open` does not read the target — it stays true while the
    // vault is in Funding. The target boundary is enforced inside `deposit`
    // via FundingTargetExceeded (see next test), not by this view.
    assert!(vault.is_funding_open());
}

#[test]
fn test_funding_progress_capped_above_target() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 300_000_000);

    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);

    // Active deposits are not target-capped → assets exceed target.
    vault.deposit(&user, &50_000_000, &user);
    assert_eq!(vault.total_assets(), 150_000_000);
    // floor(150_000_000 * 10_000 / 100_000_000) = 15_000 → clamped to 10_000.
    assert_eq!(vault.funding_progress_bps(), 10_000);
    // Active state keeps funding open for additional deposits.
    assert!(vault.is_funding_open());
}

#[test]
#[should_panic(expected = "Error(Contract, #46)")] // Error::FundingTargetExceeded
fn test_funding_deposit_reverts_above_target() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);

    vault.deposit(&user, &100_000_000, &user);
    // current (100M) + assets (1M) > target (100M) → rejected while Funding.
    vault.deposit(&user, &1_000_000, &user);
}

#[test]
fn test_is_funding_open_flips_with_pause_and_state() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);

    // Funding, unpaused → open.
    assert!(vault.is_funding_open());

    // Paused → closed (deposit would revert with VaultPaused / frozen).
    vault.pause(&ctx.admin, &String::from_str(&ctx.env, "maintenance"));
    assert!(!vault.is_funding_open());

    vault.unpause(&ctx.admin);
    assert!(vault.is_funding_open());

    // Reach target and activate → still open in Active state.
    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);
    assert!(vault.is_funding_open());
}

// ─────────────────────────────────────────────────────────────────────────────
// #1350 — share_price_bps rounding
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_share_price_bps_empty_vault_is_par() {
    let ctx = setup_with_kyc_bypass();
    // total_supply == 0 → documented par fallback of 10_000.
    assert_eq!(ctx.vault().share_price_bps(), 10_000);
}

#[test]
fn test_share_price_bps_at_par_after_funding() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);

    // First deposit mints shares 1:1 → total_assets == total_supply.
    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);
    assert_eq!(vault.share_price_bps(), 10_000);
}

#[test]
fn test_share_price_bps_even_division() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 1_000_000);

    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);

    // Yield raises total_assets without minting shares:
    // ta = 100_010_000, supply = 100_000_000.
    // 100_010_000 * 10_000 / 100_000_000 = 10_001 exactly (no remainder).
    vault.distribute_yield(&ctx.operator, &10_000);
    assert_eq!(vault.share_price_bps(), 10_001);
}

#[test]
fn test_share_price_bps_rounds_down_on_remainder() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, 200_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 1_000_000);

    vault.deposit(&user, &100_000_000, &user);
    vault.activate_vault(&ctx.admin);

    // ta = 100_025_000, supply = 100_000_000.
    // Exact value = 10_002.5 bps; implementation rounds DOWN (floor) → 10_002.
    vault.distribute_yield(&ctx.operator, &25_000);
    assert_eq!(vault.share_price_bps(), 10_002);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1351 — set_max_investors authorization & validation
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin
fn test_set_max_investors_rejects_non_admin() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();
    let user = Address::generate(&ctx.env);

    vault.set_max_investors(&user, &10u32);
}

#[test]
fn test_set_max_investors_admin_updates_cap() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    // Default is 0 (unlimited).
    assert_eq!(vault.max_investors(), 0);

    vault.set_max_investors(&ctx.admin, &10u32);
    assert_eq!(vault.max_investors(), 10);

    vault.set_max_investors(&ctx.admin, &3u32);
    assert_eq!(vault.max_investors(), 3);

    // 0 restores unlimited.
    vault.set_max_investors(&ctx.admin, &0u32);
    assert_eq!(vault.max_investors(), 0);
}

#[test]
fn test_set_max_investors_below_current_count() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    // Two investors deposit (each >= min_deposit of 1_000_000).
    let user_a = Address::generate(&ctx.env);
    let user_b = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user_a, 10_000_000);
    mint_usdc(&ctx.env, &ctx.asset_id, &user_b, 10_000_000);
    vault.deposit(&user_a, &1_000_000, &user_a);
    vault.deposit(&user_b, &1_000_000, &user_b);
    assert_eq!(vault.investor_count(), 2);

    // Setting the cap below the current count is allowed; it only blocks
    // *new* investors from here on.
    vault.set_max_investors(&ctx.admin, &1u32);
    assert_eq!(vault.max_investors(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #53)")] // Error::MaxInvestorsReached
fn test_max_investors_cap_blocks_new_investor() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    // Cap at 1 investor, then fill it.
    vault.set_max_investors(&ctx.admin, &1u32);
    let user_a = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user_a, 10_000_000);
    vault.deposit(&user_a, &1_000_000, &user_a);
    assert_eq!(vault.investor_count(), 1);

    // A second *new* investor is rejected once the cap is reached.
    let user_b = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user_b, 10_000_000);
    vault.deposit(&user_b, &1_000_000, &user_b);
}
