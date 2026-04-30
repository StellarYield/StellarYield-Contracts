//! Tests for safe_preview_deposit, safe_preview_mint (#304) and vault_asset_balance (#285).

use crate::tests::make_vault;
use crate::types::{SafePreviewDepositReason, SafePreviewMintReason};
use soroban_sdk::{testutils::Address as _, Address, Env};

// ─────────────────────────────────────────────────────────────────────────────
// safe_preview_deposit
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_safe_preview_deposit_success_empty_vault() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    // Empty vault — 1:1 conversion, no limits configured.
    let result = vault.safe_preview_deposit(&1_000_000i128);
    assert!(result.ok, "should succeed on empty vault");
    assert_eq!(result.shares, 1_000_000i128);
    assert_eq!(result.reason, SafePreviewDepositReason::None);
}

#[test]
fn test_safe_preview_deposit_success_after_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true, &None);

    // Deposit then distribute yield so share price > 1.
    token.mint(&user, &10_000i128);
    vault.deposit(&user, &10_000i128, &user);
    vault.activate_vault(&admin);
    token.mint(&operator, &2_000i128);
    vault.distribute_yield(&operator, &2_000i128);

    // safe_preview_deposit should return fewer shares than assets (price > 1).
    let result = vault.safe_preview_deposit(&6_000i128);
    assert!(result.ok);
    assert!(result.shares > 0 && result.shares < 6_000);
    assert_eq!(result.reason, SafePreviewDepositReason::None);
}

#[test]
fn test_safe_preview_deposit_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    let result = vault.safe_preview_deposit(&0i128);
    assert!(!result.ok);
    assert_eq!(result.shares, 0);
    assert_eq!(result.reason, SafePreviewDepositReason::ZeroAmount);
}

#[test]
fn test_safe_preview_deposit_negative_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    let result = vault.safe_preview_deposit(&-500i128);
    assert!(!result.ok);
    assert_eq!(result.reason, SafePreviewDepositReason::ZeroAmount);
}

#[test]
fn test_safe_preview_deposit_below_minimum() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    vault.set_deposit_limits(&admin, &5_000i128, &0i128);

    let result = vault.safe_preview_deposit(&1_000i128); // below min=5_000
    assert!(!result.ok);
    assert_eq!(result.reason, SafePreviewDepositReason::BelowMinimumDeposit);
}

#[test]
fn test_safe_preview_deposit_exceeds_max() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    vault.set_deposit_limits(&admin, &100i128, &10_000i128);

    // assets > max_deposit_per_user
    let result = vault.safe_preview_deposit(&50_000i128);
    assert!(!result.ok);
    assert_eq!(
        result.reason,
        SafePreviewDepositReason::ExceedsMaximumDeposit
    );
}

#[test]
fn test_safe_preview_deposit_funding_target_exceeded() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    let user = Address::generate(&env);
    zkme.approve_user(&user);

    // Set a tight funding target.
    vault.set_funding_target(&admin, &5_000i128);

    // Fill it almost up.
    token.mint(&user, &4_500i128);
    vault.deposit(&user, &4_500i128, &user);

    // A deposit of 1_000 would push total_assets (4_500 + 1_000 = 5_500) past target (5_000).
    let result = vault.safe_preview_deposit(&1_000i128);
    assert!(!result.ok);
    assert_eq!(
        result.reason,
        SafePreviewDepositReason::FundingTargetExceeded
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// safe_preview_mint
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_safe_preview_mint_success_empty_vault() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    // Empty vault — 1:1 conversion.
    let result = vault.safe_preview_mint(&1_000_000i128);
    assert!(result.ok);
    assert_eq!(result.assets, 1_000_000i128);
    assert_eq!(result.reason, SafePreviewMintReason::None);
}

#[test]
fn test_safe_preview_mint_success_after_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true, &None);

    token.mint(&user, &10_000i128);
    vault.deposit(&user, &10_000i128, &user);
    vault.activate_vault(&admin);
    token.mint(&operator, &2_000i128);
    vault.distribute_yield(&operator, &2_000i128);

    // safe_preview_mint cost should be > shares (share price > 1).
    let result = vault.safe_preview_mint(&5_000i128);
    assert!(result.ok);
    assert!(result.assets > 5_000);
    assert_eq!(result.reason, SafePreviewMintReason::None);
}

#[test]
fn test_safe_preview_mint_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    let result = vault.safe_preview_mint(&0i128);
    assert!(!result.ok);
    assert_eq!(result.assets, 0);
    assert_eq!(result.reason, SafePreviewMintReason::ZeroAmount);
}

#[test]
fn test_safe_preview_mint_negative_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    let result = vault.safe_preview_mint(&-1i128);
    assert!(!result.ok);
    assert_eq!(result.reason, SafePreviewMintReason::ZeroAmount);
}

#[test]
fn test_safe_preview_mint_below_minimum() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    // min_deposit = 50_000, requesting only 100 shares (cost = 100 at 1:1 < min)
    vault.set_deposit_limits(&admin, &50_000i128, &0i128);

    let result = vault.safe_preview_mint(&100i128);
    assert!(!result.ok);
    assert_eq!(result.reason, SafePreviewMintReason::BelowMinimumDeposit);
}

#[test]
fn test_safe_preview_mint_exceeds_max() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    vault.set_deposit_limits(&admin, &100i128, &10_000i128);

    // 500_000 shares → cost 500_000 > max 10_000
    let result = vault.safe_preview_mint(&500_000i128);
    assert!(!result.ok);
    assert_eq!(result.reason, SafePreviewMintReason::ExceedsMaximumDeposit);
}

#[test]
fn test_safe_preview_mint_funding_target_exceeded() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    let user = Address::generate(&env);
    zkme.approve_user(&user);

    vault.set_funding_target(&admin, &5_000i128);
    token.mint(&user, &4_500i128);
    vault.deposit(&user, &4_500i128, &user);

    // 1_000 shares at 1:1 → cost 1_000; total would be 5_500 > target 5_000.
    let result = vault.safe_preview_mint(&1_000i128);
    assert!(!result.ok);
    assert_eq!(result.reason, SafePreviewMintReason::FundingTargetExceeded);
}

// ─────────────────────────────────────────────────────────────────────────────
// vault_asset_balance (#285)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_vault_asset_balance_empty() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);

    // No deposits yet — raw balance should be 0.
    assert_eq!(vault.vault_asset_balance(), 0i128);
}

#[test]
fn test_vault_asset_balance_after_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, _admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    let user = Address::generate(&env);
    zkme.approve_user(&user);

    token.mint(&user, &7_500i128);
    vault.deposit(&user, &7_500i128, &user);

    // Raw token balance == total_assets for a normal (non-fee-on-transfer) token.
    assert_eq!(vault.vault_asset_balance(), 7_500i128);
    assert_eq!(vault.total_assets(), 7_500i128);
}

#[test]
fn test_vault_asset_balance_after_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true, &None);

    token.mint(&user, &10_000i128);
    vault.deposit(&user, &10_000i128, &user);
    vault.activate_vault(&admin);
    token.mint(&operator, &3_000i128);
    vault.distribute_yield(&operator, &3_000i128);

    // After yield, raw balance = deposits + yield = 13_000.
    assert_eq!(vault.vault_asset_balance(), 13_000i128);
    assert_eq!(vault.total_assets(), 13_000i128);
}
