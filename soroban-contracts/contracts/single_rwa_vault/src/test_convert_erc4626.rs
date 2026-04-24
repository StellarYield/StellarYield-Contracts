//! Tests for ERC-4626 convert_to_shares and convert_to_assets (floor division).

use crate::tests::make_vault;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_convert_to_shares_and_assets_floor_division() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true);

    // Helper to mint assets to user and deposit into vault
    let mint_and_deposit = |amount: i128| {
        token.mint(&user, &amount);
        vault.deposit(&user, &amount, &user);
    };

    // 1) Zero supply: 1:1 conversion
    assert_eq!(vault.convert_to_shares(&1000i128), 1000i128);
    assert_eq!(vault.convert_to_assets(&1000i128), 1000i128);

    // 2) Deposit to create non-zero supply/assets
    mint_and_deposit(10_000i128);
    assert_eq!(vault.total_supply(), 10_000i128);
    let total_assets = token.balance(&vault_id);
    assert_eq!(total_assets, 10_000i128);

    // 3) Floor division vs ceiling (preview) when not perfectly divisible
    // Example: assets=1, totalSupply=10_000, totalAssets=10_000
    // convert_to_shares should floor: 1 * 10_000 / 10_000 = 1
    // preview_deposit (same formula) also returns 1 here, but we test a case where rounding differs
    let assets_in = 3333i128;
    let shares_via_convert = vault.convert_to_shares(&assets_in);
    let shares_via_preview = vault.preview_deposit(&assets_in);
    // In this simple 1:1 case, both are equal
    assert_eq!(shares_via_convert, shares_via_preview);
    assert!(shares_via_convert <= assets_in + 1); // sanity

    // 4) Convert back: assets = shares * totalAssets / totalSupply (floor)
    let assets_back = vault.convert_to_assets(&shares_via_convert);
    // Due to floor division both ways, round-trip may lose dust; test within 1 unit
    assert!(assets_back <= assets_in);
    assert!(assets_back >= assets_in - 1);

    // 5) Change price via yield to test rounding differences
    // Activate vault first to allow yield distribution
    vault.activate_vault(&admin);
    // Operator injects 2,000 assets as yield (no new shares)
    token.mint(&operator, &2000i128);
    vault.distribute_yield(&operator, &2000i128);
    let total_assets_after_yield = token.balance(&vault_id);
    assert_eq!(total_assets_after_yield, 12_000i128);
    assert_eq!(vault.total_supply(), 10_000i128); // shares unchanged

    // Now share price = 12,000 / 10,000 = 1.2
    // With virtual offset: shares = assets * (supply + OFFSET) / (totalAssets + OFFSET)
    // Convert 3,333 assets -> shares (floor)
    let assets_in = 3333i128;
    let shares = vault.convert_to_shares(&assets_in);
    // Just verify the conversion works and is consistent
    assert!(shares > 0, "Should receive shares");

    // Convert those shares back to assets (floor)
    let assets_back = vault.convert_to_assets(&shares);
    // Due to virtual offset and rounding, assets_back should be close to assets_in
    assert!(
        assets_back >= assets_in - 10 && assets_back <= assets_in,
        "Round-trip should be close"
    );

    // Verify preview vs convert rounding difference:
    // preview_deposit uses floor division (same as convert for deposit)
    let shares_preview = vault.preview_deposit(&assets_in);
    // With virtual offset, preview_deposit should match convert_to_shares
    assert_eq!(shares_preview, shares);

    // preview_mint uses ceiling division for assets
    let assets_preview = vault.preview_mint(&shares);
    assert!(assets_preview >= assets_back); // ceiling >= floor
}

#[test]
fn test_convert_edge_cases_zero_assets_or_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true);

    // Zero assets, zero supply: 1:1
    assert_eq!(vault.convert_to_shares(&5000i128), 5000i128);
    assert_eq!(vault.convert_to_assets(&5000i128), 5000i128);

    // Deposit to create assets and supply
    token.mint(&user, &8000i128);
    vault.deposit(&user, &8000i128, &user);
    assert_eq!(vault.total_supply(), 8000i128);
    let total_assets = token.balance(&vault_id);
    assert_eq!(total_assets, 8000i128);

    // Now zero assets passed to convert_to_shares should return 0
    assert_eq!(vault.convert_to_shares(&0i128), 0i128);
    // Zero shares passed to convert_to_assets should return 0
    assert_eq!(vault.convert_to_assets(&0i128), 0i128);
}

#[test]
fn test_convert_vs_preview_rounding_differences() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    let vault = crate::SingleRWAVaultClient::new(&env, &vault_id);
    let token = crate::tests::MockTokenClient::new(&env, &token_id);
    let zkme = crate::tests::MockZkmeClient::new(&env, &zkme_id);
    zkme.approve_user(&user);
    vault.set_operator(&admin, &operator, &true);

    // Create non-trivial price
    vault.activate_vault(&admin);
    token.mint(&user, &10_000i128);
    vault.deposit(&user, &10_000i128, &user);
    token.mint(&operator, &1234i128);
    vault.distribute_yield(&operator, &1234i128);

    let total_assets = token.balance(&vault_id);
    let total_supply = vault.total_supply();
    assert!(total_assets > total_supply); // price > 1

    // Pick an amount that will cause rounding differences
    let assets_in = 123i128;
    let shares_convert = vault.convert_to_shares(&assets_in);
    let shares_preview = vault.preview_deposit(&assets_in);
    // With virtual offset, both use the same formula (floor division)
    assert_eq!(shares_preview, shares_convert);

    // Now test assets from shares
    let shares_in = 57i128;
    let assets_convert = vault.convert_to_assets(&shares_in);
    let assets_preview = vault.preview_mint(&shares_in);
    // preview_mint uses ceiling, so >= convert (floor)
    assert!(assets_preview >= assets_convert);
    if assets_preview > assets_convert {
        // Gap should be at most 1 asset unit
        assert_eq!(assets_preview - assets_convert, 1);
    }
}
