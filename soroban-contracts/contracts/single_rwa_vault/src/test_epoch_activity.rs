extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::test_helpers::{advance_time, mint_usdc, setup_with_kyc_bypass};
use crate::SingleRWAVaultClient;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Set funding target to 0 and transition the vault to Active state.
fn activate_vault_zero_target(env: &Env, client: &SingleRWAVaultClient, operator: &Address) {
    client.set_funding_target(operator, &0i128);
    client.activate_vault(operator);
    // Advance one second so timestamp-sensitive paths don't hit edge cases.
    advance_time(env, 1);
}

/// Distribute `amount` yield into the vault (mints asset to operator first).
fn distribute_yield(
    env: &Env,
    client: &SingleRWAVaultClient,
    asset_id: &Address,
    operator: &Address,
    amount: i128,
) {
    mint_usdc(env, asset_id, operator, amount);
    client.distribute_yield(operator, &amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deposit / mint activity (#122)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_epoch_activity_tracks_single_deposit() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    // min_deposit = 1_000_000 in default setup
    mint_usdc(e, &ctx.asset_id, &ctx.user, 1_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);

    let act = client.get_epoch_activity(&0u32);
    assert_eq!(act.deposits_count, 1);
    assert_eq!(act.deposits_volume, 1_000_000);
    assert_eq!(act.new_investors, 1);

    let lifetime = client.get_lifetime_activity();
    assert_eq!(lifetime.deposits_count, 1);
    assert_eq!(lifetime.deposits_volume, 1_000_000);
    assert_eq!(lifetime.new_investors, 1);
}

#[test]
fn test_epoch_activity_second_deposit_not_new_investor() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 2_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);

    let act = client.get_epoch_activity(&0u32);
    assert_eq!(act.deposits_count, 2);
    assert_eq!(act.deposits_volume, 2_000_000);
    assert_eq!(
        act.new_investors, 1,
        "second deposit must not count as new investor"
    );
}

#[test]
fn test_epoch_activity_new_investor_per_unique_user() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);
    let user2 = Address::generate(e);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 1_000_000);
    mint_usdc(e, &ctx.asset_id, &user2, 1_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);
    client.deposit(&user2, &1_000_000i128, &user2);

    let act = client.get_epoch_activity(&0u32);
    assert_eq!(act.deposits_count, 2);
    assert_eq!(
        act.new_investors, 2,
        "each first-time depositor is a new investor"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdrawal / redeem activity
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_epoch_activity_tracks_partial_withdrawal() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 2_000_000);
    client.deposit(&ctx.user, &2_000_000i128, &ctx.user);
    activate_vault_zero_target(e, &client, &ctx.operator);

    client.withdraw(&ctx.user, &1_000_000i128, &ctx.user, &ctx.user);

    let act = client.get_epoch_activity(&0u32);
    assert_eq!(act.withdrawals_count, 1);
    assert_eq!(act.withdrawals_volume, 1_000_000);
    assert_eq!(
        act.exiting_investors, 0,
        "partial withdrawal is not an exit"
    );
}

#[test]
fn test_epoch_activity_exiting_investor_on_full_redeem() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 1_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);
    activate_vault_zero_target(e, &client, &ctx.operator);

    let shares = client.balance(&ctx.user);
    client.redeem(&ctx.user, &shares, &ctx.user, &ctx.user);

    let act = client.get_epoch_activity(&0u32);
    assert_eq!(act.withdrawals_count, 1);
    assert_eq!(
        act.exiting_investors, 1,
        "full redemption must count as exiting investor"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer activity
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_epoch_activity_tracks_transfer() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);
    let recipient = Address::generate(e);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 2_000_000);
    client.deposit(&ctx.user, &2_000_000i128, &ctx.user);

    // Disable transfer KYC so the recipient doesn't need KYC approval.
    client.set_transfer_requires_kyc(&ctx.admin, &false);
    client.transfer(&ctx.user, &recipient, &1_000_000i128);

    let act = client.get_epoch_activity(&0u32);
    assert_eq!(act.transfers_count, 1);
    assert_eq!(act.transfers_volume, 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Yield claim activity
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_epoch_activity_tracks_yield_claim() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 1_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);
    activate_vault_zero_target(e, &client, &ctx.operator);

    distribute_yield(e, &client, &ctx.asset_id, &ctx.operator, 100_000);
    advance_time(e, 1);

    let claimed = client.claim_yield(&ctx.user);
    assert!(claimed > 0);

    let epoch = client.current_epoch();
    let act = client.get_epoch_activity(&epoch);
    assert_eq!(act.yield_claims_count, 1);
    assert_eq!(act.yield_claims_volume, claimed);

    let lifetime = client.get_lifetime_activity();
    assert_eq!(lifetime.yield_claims_count, 1);
    assert_eq!(lifetime.yield_claims_volume, claimed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifetime accumulation across multiple epochs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_lifetime_activity_accumulates_across_epochs() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 1_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);
    activate_vault_zero_target(e, &client, &ctx.operator);

    // Epoch 1 yield claim.
    distribute_yield(e, &client, &ctx.asset_id, &ctx.operator, 50_000);
    advance_time(e, 1);
    let claimed1 = client.claim_yield(&ctx.user);

    // Epoch 2 yield claim.
    distribute_yield(e, &client, &ctx.asset_id, &ctx.operator, 50_000);
    advance_time(e, 1);
    let claimed2 = client.claim_yield(&ctx.user);

    let lifetime = client.get_lifetime_activity();
    assert_eq!(lifetime.deposits_count, 1);
    assert_eq!(lifetime.deposits_volume, 1_000_000);
    assert_eq!(lifetime.yield_claims_count, 2);
    assert_eq!(lifetime.yield_claims_volume, claimed1 + claimed2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-activity epoch returns zeroed struct
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_get_epoch_activity_returns_zero_for_inactive_epoch() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    let act = client.get_epoch_activity(&99u32);
    assert_eq!(act.deposits_count, 0);
    assert_eq!(act.deposits_volume, 0);
    assert_eq!(act.withdrawals_count, 0);
    assert_eq!(act.yield_claims_count, 0);
    assert_eq!(act.new_investors, 0);
}

#[test]
fn test_get_lifetime_activity_returns_zero_before_any_ops() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    let act = client.get_lifetime_activity();
    assert_eq!(act.deposits_count, 0);
    assert_eq!(act.withdrawals_count, 0);
    assert_eq!(act.transfers_count, 0);
    assert_eq!(act.yield_claims_count, 0);
    assert_eq!(act.redemptions_count, 0);
}

#[test]
fn test_last_interaction_epoch_getter_defaults_and_updates() {
    let ctx = setup_with_kyc_bypass();
    let e = &ctx.env;
    let client = SingleRWAVaultClient::new(e, &ctx.vault_id);

    // No interaction yet -> defaults to epoch 0.
    assert_eq!(client.last_interaction_epoch(&ctx.user), 0);

    mint_usdc(e, &ctx.asset_id, &ctx.user, 1_000_000);
    client.deposit(&ctx.user, &1_000_000i128, &ctx.user);

    // Deposit records interaction in current epoch.
    assert_eq!(client.last_interaction_epoch(&ctx.user), client.current_epoch());
}
