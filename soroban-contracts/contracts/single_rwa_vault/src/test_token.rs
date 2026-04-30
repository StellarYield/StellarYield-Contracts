extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env, String,
};

use crate::storage::{
    get_current_epoch, get_has_snapshot_for_epoch, get_share_balance, get_total_deposited,
    get_total_supply, get_user_shares_at_epoch, put_current_epoch, put_epoch_total_shares,
    put_epoch_yield, put_share_balance, put_total_deposited, put_total_supply,
};
use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass};
use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─── Shared helpers ───────────────────────────────────────────────────────────

fn default_params(env: &Env, admin: &Address, asset: &Address) -> InitParams {
    InitParams {
        asset: asset.clone(),
        share_name: String::from_str(env, "Vault Share"),
        share_symbol: String::from_str(env, "VS"),
        share_decimals: 7,
        admin: admin.clone(),
        zkme_verifier: admin.clone(),
        cooperator: admin.clone(),
        funding_target: 10_000_000_000_000_i128,
        maturity_date: 9_999_999_999_u64,
        min_deposit: 1_000_i128,
        max_deposit_per_user: 0_i128,
        early_redemption_fee_bps: 100_u32,
        operator_fee_bps: 0u32,
        funding_deadline: 0_u64,
        rwa_name: String::from_str(env, "Test RWA"),
        rwa_symbol: String::from_str(env, "TRWA"),
        rwa_document_uri: String::from_str(env, "https://test.com"),
        rwa_category: String::from_str(env, "Real Estate"),
        expected_apy: 500_u32,
        timelock_delay: 172800u64, // 48 hours
        yield_vesting_period: 0u64,
    }
}

/// Standard setup: global auth mock for convenience.
/// Use for tests that do **not** need to verify emitted events.
fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let asset_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let vault_id = env.register(SingleRWAVault, (default_params(&env, &admin, &asset_id),));

    // Redirect zkme_verifier to the vault itself → is_kyc_verified always true.
    SingleRWAVaultClient::new(&env, &vault_id).set_zkme_verifier(&admin, &vault_id);

    (env, vault_id, asset_id, admin)
}

/// Directly credit `amount` vault-shares to `user` via contract storage,
/// bypassing the deposit flow (no asset transfer, no KYC, no min-deposit).
fn give_shares(env: &Env, vault_id: &Address, user: &Address, amount: i128) {
    env.as_contract(vault_id, || {
        let bal = get_share_balance(env, user);
        put_share_balance(env, user, bal + amount);
        let sup = get_total_supply(env);
        put_total_supply(env, sup + amount);
        // `total_assets` tracks principal (`total_deposited`); keep it in sync so
        // preview_* redeem/withdraw math matches share supply.
        let td = get_total_deposited(env);
        put_total_deposited(env, td + amount);
    });
}

/// Advance the vault's epoch counter and store per-epoch accounting data
/// directly in contract storage (bypasses the Active-state guard).
fn advance_epoch(
    env: &Env,
    vault_id: &Address,
    epoch: u32,
    yield_amount: i128,
    total_shares: i128,
) {
    env.as_contract(vault_id, || {
        put_current_epoch(env, epoch);
        put_epoch_yield(env, epoch, yield_amount);
        put_epoch_total_shares(env, epoch, total_shares);
    });
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

/// decimals / name / symbol all round-trip through the InitParams.
#[test]
fn test_decimals_name_symbol() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    assert_eq!(client.decimals(), 7);
    assert_eq!(client.name(), String::from_str(&env, "Vault Share"));
    assert_eq!(client.symbol(), String::from_str(&env, "VS"));
}

// ─── Balance ──────────────────────────────────────────────────────────────────

/// balance() returns 0 for an address that has never held shares.
#[test]
fn test_balance_uninitialized_is_zero() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let stranger = Address::generate(&env);

    assert_eq!(client.balance(&stranger), 0_i128);
}

/// Depositing underlying assets through the normal flow returns the correct
/// share count (1:1 at an empty vault) and balance() agrees.
#[test]
fn test_balance_after_deposit() {
    let (env, vault_id, asset_id, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);

    StellarAssetClient::new(&env, &asset_id).mint(&alice, &10_000_i128);

    let shares = client.deposit(&alice, &1_000_i128, &alice);

    // First deposit: supply == 0, so preview_deposit returns assets 1:1.
    assert_eq!(shares, 1_000_i128);
    assert_eq!(client.balance(&alice), 1_000_i128);
}

/// total_supply mirrors the net of all mints and burns.
#[test]
fn test_total_supply_tracks_mints_and_burns() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 500_i128);
    assert_eq!(client.total_supply(), 500_i128);

    client.burn(&alice, &200_i128);
    assert_eq!(client.balance(&alice), 300_i128);
    assert_eq!(client.total_supply(), 300_i128);
}

// ─── Transfer ─────────────────────────────────────────────────────────────────

/// transfer panics when the sender holds fewer shares than the requested amount.
#[test]
#[should_panic]
fn test_transfer_panics_on_insufficient_balance() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 100_i128);
    client.transfer(&alice, &bob, &200_i128); // more than alice holds
}

/// transfer calls update_user_snapshot for both parties *before* adjusting
/// balances, so each snapshot records the pre-transfer share count.
#[test]
fn test_transfer_updates_snapshots() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 1_000_i128);
    // Advance to epoch 1 — mimics what distribute_yield would record.
    advance_epoch(&env, &vault_id, 1, 100_i128, 1_000_i128);

    client.transfer(&alice, &bob, &400_i128);

    // Snapshots are written with balances as of the START of epoch 1.
    env.as_contract(&vault_id, || {
        assert!(get_has_snapshot_for_epoch(&env, &alice, 1));
        assert_eq!(get_user_shares_at_epoch(&env, &alice, 1), 1_000_i128);

        assert!(get_has_snapshot_for_epoch(&env, &bob, 1));
        assert_eq!(get_user_shares_at_epoch(&env, &bob, 1), 0_i128);
    });

    assert_eq!(client.balance(&alice), 600_i128);
    assert_eq!(client.balance(&bob), 400_i128);
}

// ─── Allowance & transfer_from ────────────────────────────────────────────────

/// approve stores the allowance; a second approve overwrites it.
#[test]
fn test_approve_updates_allowance() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let spender = Address::generate(&env);

    let expiry = env.ledger().sequence() + 1_000_u32;
    client.approve(&alice, &spender, &500_i128, &expiry);
    assert_eq!(client.allowance(&alice, &spender), 500_i128);

    // Overwrite with a lower amount.
    client.approve(&alice, &spender, &150_i128, &expiry);
    assert_eq!(client.allowance(&alice, &spender), 150_i128);
}

/// transfer_from moves shares and decrements the spender's allowance
/// by exactly the transferred amount.
#[test]
fn test_transfer_from_spends_allowance() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let spender = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 1_000_i128);

    let expiry = env.ledger().sequence() + 1_000_u32;
    client.approve(&alice, &spender, &600_i128, &expiry);
    client.transfer_from(&spender, &alice, &bob, &400_i128);

    assert_eq!(client.allowance(&alice, &spender), 200_i128); // 600 − 400
    assert_eq!(client.balance(&alice), 600_i128);
    assert_eq!(client.balance(&bob), 400_i128);
}

/// transfer_from panics when the spender has no allowance.
#[test]
#[should_panic]
fn test_transfer_from_insufficient_allowance_panics() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let spender = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 1_000_i128);
    // No approve — allowance is 0.
    client.transfer_from(&spender, &alice, &bob, &100_i128);
}

// ─── Burn ─────────────────────────────────────────────────────────────────────

/// burn reduces both balance and total_supply.
#[test]
fn test_burn_reduces_balance_and_supply() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 800_i128);
    client.burn(&alice, &300_i128);

    assert_eq!(client.balance(&alice), 500_i128);
    assert_eq!(client.total_supply(), 500_i128);
}

/// burn_from decrements the spender's allowance and removes shares from
/// the owner, updating both balance and total_supply.
#[test]
fn test_burn_from_spends_allowance() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let spender = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 1_000_i128);

    let expiry = env.ledger().sequence() + 1_000_u32;
    client.approve(&alice, &spender, &400_i128, &expiry);
    client.burn_from(&spender, &alice, &250_i128);

    assert_eq!(client.allowance(&alice, &spender), 150_i128); // 400 − 250
    assert_eq!(client.balance(&alice), 750_i128);
    assert_eq!(client.total_supply(), 750_i128);
}

/// burn_from panics when the spender's allowance is insufficient.
#[test]
#[should_panic]
fn test_burn_from_insufficient_allowance_panics() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let spender = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 1_000_i128);
    // No approve — allowance is 0.
    client.burn_from(&spender, &alice, &100_i128);
}

/// burn panics when the holder's balance is insufficient.
#[test]
#[should_panic]
fn test_burn_insufficient_balance_panics() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 100_i128);
    client.burn(&alice, &200_i128); // more than alice holds
}

// ─── Allowance expiration ──────────────────────────────────────────────────────

/// allowance() returns 0 once the ledger sequence advances past expiration_ledger.
#[test]
fn test_allowance_returns_zero_after_expiration() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let spender = Address::generate(&env);

    // Approve with an expiry 10 ledgers from now.
    let current = env.ledger().sequence();
    let expiry = current + 10;
    client.approve(&alice, &spender, &500_i128, &expiry);
    assert_eq!(client.allowance(&alice, &spender), 500_i128);

    // Advance the ledger past the expiration.
    env.ledger().set_sequence_number(expiry + 1);
    assert_eq!(client.allowance(&alice, &spender), 0_i128);
}

/// transfer_from panics when the allowance has expired, even if the raw
/// storage amount is non-zero.
#[test]
#[should_panic]
fn test_transfer_from_expired_allowance_panics() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let spender = Address::generate(&env);

    give_shares(&env, &vault_id, &alice, 1_000_i128);

    // Approve with an expiry 5 ledgers from now.
    let expiry = env.ledger().sequence() + 5;
    client.approve(&alice, &spender, &600_i128, &expiry);

    // Advance the ledger past the expiration — allowance is effectively 0.
    env.ledger().set_sequence_number(expiry + 1);

    // This must panic because get_share_allowance returns 0 for expired allowances.
    client.transfer_from(&spender, &alice, &bob, &100_i128);
}

// ─── preview_* purity (#179) ──────────────────────────────────────────────────

/// preview_deposit called repeatedly must not mutate total_supply or the
/// current epoch — it is a pure view.
#[test]
fn test_preview_deposit_does_not_mutate_state() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    // Seed some shares so the ratio is non-trivial.
    let alice = Address::generate(&env);
    give_shares(&env, &vault_id, &alice, 5_000_i128);

    let (supply_before, epoch_before) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    // Call three times with different inputs — none must mutate state.
    let _ = client.preview_deposit(&1_000_i128);
    let _ = client.preview_deposit(&5_000_i128);
    let _ = client.preview_deposit(&10_000_i128);

    let (supply_after, epoch_after) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    assert_eq!(
        supply_before, supply_after,
        "preview_deposit must not change total_supply"
    );
    assert_eq!(
        epoch_before, epoch_after,
        "preview_deposit must not change current_epoch"
    );
}

/// preview_mint called repeatedly must not mutate total_supply or the
/// current epoch.
#[test]
fn test_preview_mint_does_not_mutate_state() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let alice = Address::generate(&env);
    give_shares(&env, &vault_id, &alice, 5_000_i128);

    let (supply_before, epoch_before) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    let _ = client.preview_mint(&500_i128);
    let _ = client.preview_mint(&2_000_i128);
    let _ = client.preview_mint(&5_000_i128);

    let (supply_after, epoch_after) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    assert_eq!(
        supply_before, supply_after,
        "preview_mint must not change total_supply"
    );
    assert_eq!(
        epoch_before, epoch_after,
        "preview_mint must not change current_epoch"
    );
}

/// preview_withdraw called repeatedly must not mutate total_supply or the
/// current epoch.
#[test]
fn test_preview_withdraw_does_not_mutate_state() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let alice = Address::generate(&env);
    give_shares(&env, &vault_id, &alice, 5_000_i128);

    let (supply_before, epoch_before) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    let _ = client.preview_withdraw(&100_i128);
    let _ = client.preview_withdraw(&1_000_i128);
    let _ = client.preview_withdraw(&3_000_i128);

    let (supply_after, epoch_after) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    assert_eq!(
        supply_before, supply_after,
        "preview_withdraw must not change total_supply"
    );
    assert_eq!(
        epoch_before, epoch_after,
        "preview_withdraw must not change current_epoch"
    );
}

/// preview_redeem called repeatedly must not mutate total_supply or the
/// current epoch.
#[test]
fn test_preview_redeem_does_not_mutate_state() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let alice = Address::generate(&env);
    give_shares(&env, &vault_id, &alice, 5_000_i128);

    let (supply_before, epoch_before) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    let _ = client.preview_redeem(&500_i128);
    let _ = client.preview_redeem(&2_000_i128);
    let _ = client.preview_redeem(&5_000_i128);

    let (supply_after, epoch_after) = env.as_contract(&vault_id, || {
        (get_total_supply(&env), get_current_epoch(&env))
    });

    assert_eq!(
        supply_before, supply_after,
        "preview_redeem must not change total_supply"
    );
    assert_eq!(
        epoch_before, epoch_after,
        "preview_redeem must not change current_epoch"
    );
}

/// Repeated calls to every preview_* function return consistent results —
/// calling the same function twice with the same input yields the same output.
#[test]
fn test_preview_calls_return_consistent_results() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    let alice = Address::generate(&env);
    give_shares(&env, &vault_id, &alice, 5_000_i128);

    let assets_in = 2_000_i128;
    let shares_in = 1_500_i128;

    let deposit1 = client.preview_deposit(&assets_in);
    let deposit2 = client.preview_deposit(&assets_in);
    assert_eq!(deposit1, deposit2, "preview_deposit must be idempotent");

    let mint1 = client.preview_mint(&shares_in);
    let mint2 = client.preview_mint(&shares_in);
    assert_eq!(mint1, mint2, "preview_mint must be idempotent");

    let withdraw1 = client.preview_withdraw(&assets_in);
    let withdraw2 = client.preview_withdraw(&assets_in);
    assert_eq!(withdraw1, withdraw2, "preview_withdraw must be idempotent");

    let redeem1 = client.preview_redeem(&shares_in);
    let redeem2 = client.preview_redeem(&shares_in);
    assert_eq!(redeem1, redeem2, "preview_redeem must be idempotent");
}

// ─── Zero-amount edge cases (#174) ────────────────────────────────────────────

/// All ERC-4626 preview helpers accept `amount = 0` and return 0 without panicking.
#[test]
fn test_preview_methods_zero_amount_return_zero() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);

    assert_eq!(client.preview_deposit(&0_i128), 0_i128);
    assert_eq!(client.preview_mint(&0_i128), 0_i128);
    assert_eq!(client.preview_withdraw(&0_i128), 0_i128);
    assert_eq!(client.preview_redeem(&0_i128), 0_i128);

    let holder = Address::generate(&env);
    give_shares(&env, &vault_id, &holder, 10_000_i128);
    assert_eq!(client.preview_withdraw(&0_i128), 0_i128);
    assert_eq!(client.preview_redeem(&0_i128), 0_i128);
}

/// deposit with `assets = 0` is rejected when `min_deposit` is strictly positive.
#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_deposit_zero_below_minimum_panics() {
    let (env, vault_id, _, _) = setup();
    let client = SingleRWAVaultClient::new(&env, &vault_id);
    let user = Address::generate(&env);
    client.deposit(&user, &0_i128, &user);
}

/// withdraw with `assets = 0` is rejected with Error::ZeroAmount.
#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_withdraw_zero_amount_panics() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let dep = ctx.params.funding_target;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, dep);
    v.deposit(&ctx.user, &dep, &ctx.user);
    v.activate_vault(&ctx.operator);
    v.withdraw(&ctx.user, &0_i128, &ctx.user, &ctx.user);
}

/// redeem with `shares = 0` is rejected with Error::ZeroAmount.
#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_redeem_zero_shares_panics() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();
    let dep = ctx.params.funding_target;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, dep);
    v.deposit(&ctx.user, &dep, &ctx.user);
    v.activate_vault(&ctx.operator);
    v.redeem(&ctx.user, &0_i128, &ctx.user, &ctx.user);
}
