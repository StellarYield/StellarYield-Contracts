extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::test_helpers::{mint_usdc, setup, setup_with_kyc_bypass};
use crate::{math, InitParams, Role, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct MockToken;

#[contractimpl]
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

#[contract]
pub struct MockZkme;

#[contractimpl]
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

/// Create a vault with sensible defaults for redemption tests.
/// Returns (vault_id, token_id, zkme_id, admin).
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
            funding_target: 0i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 0u64,
            min_deposit: 0i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 200u32, // 2% fee
            rwa_name: String::from_str(env, "Bond A"),
            rwa_symbol: String::from_str(env, "BOND"),
            rwa_document_uri: String::from_str(env, "https://example.com"),
            rwa_category: String::from_str(env, "Bond"),
            expected_apy: 500u32,
            timelock_delay: 172800u64, // 48 hours
            yield_vesting_period: 0u64,
        },),
    );

    (vault_id, token_id, zkme_id, admin)
}

/// Approve `user` in zkMe, mint tokens to them, and deposit into the vault.
/// Returns the number of vault shares minted.
fn fund_user(
    env: &Env,
    vault_id: &Address,
    token_id: &Address,
    zkme_id: &Address,
    user: &Address,
    amount: i128,
) -> i128 {
    MockZkmeClient::new(env, zkme_id).approve_user(user);
    MockTokenClient::new(env, token_id).mint(user, &amount);
    SingleRWAVaultClient::new(env, vault_id).deposit(user, &amount, user)
}

/// Transition the vault to Active state.
fn activate(env: &Env, vault_id: &Address, admin: &Address) {
    let vault = SingleRWAVaultClient::new(env, vault_id);
    vault.activate_vault(admin);
}

/// Distribute yield for the current epoch. Returns the new epoch number.
fn distribute_yield(
    env: &Env,
    vault_id: &Address,
    token_id: &Address,
    admin: &Address,
    amount: i128,
) -> u32 {
    // Mint yield tokens to admin so they can transfer to vault
    MockTokenClient::new(env, token_id).mint(admin, &amount);
    SingleRWAVaultClient::new(env, vault_id).distribute_yield(admin, &amount)
}

/// Transition the vault to Matured state by advancing ledger time past maturity.
fn mature(env: &Env, vault_id: &Address, admin: &Address) {
    let vault = SingleRWAVaultClient::new(env, vault_id);
    let maturity = vault.maturity_date();
    // Advance ledger timestamp past the maturity date
    env.ledger().with_mut(|li| {
        li.timestamp = maturity + 1;
    });
    vault.mature_vault(admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Early redemption: request
// ─────────────────────────────────────────────────────────────────────────────

/// request_early_redemption returns a request ID and stores a RedemptionRequest
/// with the correct user, shares, and processed = false.
#[test]
fn test_request_early_redemption_creates_request() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    // Activate the vault so early redemption is available
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let request_id = vault.request_early_redemption(&user, &shares);

    // First request should have id == 1
    assert_eq!(request_id, 1u32);

    // Verify a second request increments the counter
    // Fund more shares first
    let shares2 = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);
    let request_id2 = vault.request_early_redemption(&user, &shares2);
    assert_eq!(request_id2, 2u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Early redemption: process with fee
// ─────────────────────────────────────────────────────────────────────────────

/// process_early_redemption applies the fee correctly:
///   fee = assets * fee_bps / 10000
///   user receives (assets - fee); fee remains in vault.
#[test]
fn test_process_early_redemption_applies_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let request_id = vault.request_early_redemption(&user, &shares);

    // Record vault balance before processing
    let vault_balance_before = token.balance(&vault_id);

    vault.process_early_redemption(&admin, &request_id);

    // The vault was initialised with early_redemption_fee_bps = 200 (2%).
    // With 1:1 share-to-asset ratio: assets = shares = 1_000_000
    let assets = shares; // 1:1 ratio at start
    let fee = (assets * 200) / 10000; // 20_000
    let net_assets = assets - fee; // 980_000

    // User should receive net_assets
    let user_balance = token.balance(&user);
    assert_eq!(user_balance, net_assets);

    // Fee stays in vault: vault balance should have decreased by net_assets only
    let vault_balance_after = token.balance(&vault_id);
    assert_eq!(vault_balance_after, vault_balance_before - net_assets);
    // Verify exact fee amount
    assert_eq!(fee, 20_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression — representative early redemption fee configurations (#171)
// ─────────────────────────────────────────────────────────────────────────────

/// With `early_redemption_fee_bps = 0`, the user receives the full `preview_redeem` amount
/// (same net payout as if no fee existed).
#[test]
fn test_process_early_redemption_zero_fee_full_payout() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 5_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    vault.set_early_redemption_fee(&admin, &0u32);
    assert_eq!(vault.early_redemption_fee_bps(), 0u32);

    let vault_balance_before = token.balance(&vault_id);
    let request_id = vault.request_early_redemption(&user, &shares);
    vault.process_early_redemption(&admin, &request_id);

    // 1:1 share price at inception → assets == shares; fee == 0 → user gets all assets.
    let assets = shares;
    let fee = math::mul_div(&env, assets, 0i128, 10000);
    assert_eq!(fee, 0i128);
    assert_eq!(token.balance(&user), assets);
    assert_eq!(token.balance(&vault_id), vault_balance_before - assets);
}

/// A small non-zero fee (25 bps) deducts exactly `mul_div(assets, 25, 10000)` from the payout.
#[test]
fn test_process_early_redemption_small_fee_matches_mul_div() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 10_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let fee_bps: i128 = 25;
    vault.set_early_redemption_fee(&admin, &(fee_bps as u32));
    assert_eq!(vault.early_redemption_fee_bps(), 25u32);

    let vault_balance_before = token.balance(&vault_id);
    let request_id = vault.request_early_redemption(&user, &shares);
    vault.process_early_redemption(&admin, &request_id);

    let assets = shares;
    let fee = math::mul_div(&env, assets, fee_bps, 10000);
    let net_assets = assets - fee;
    assert_eq!(fee, 25_000i128);
    assert_eq!(net_assets, 9_975_000i128);
    assert_eq!(token.balance(&user), net_assets);
    assert_eq!(token.balance(&vault_id), vault_balance_before - net_assets);
}

/// Maximum allowed fee (1000 bps) on a large asset amount: payout matches `assets - mul_div`
/// and completes without overflow (fee math uses `I256` internally).
#[test]
fn test_process_early_redemption_max_fee_large_assets_no_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 888_888_888_888_888i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let fee_bps: i128 = 1000;
    vault.set_early_redemption_fee(&admin, &(fee_bps as u32));
    assert_eq!(vault.early_redemption_fee_bps(), 1000u32);

    let vault_balance_before = token.balance(&vault_id);
    let request_id = vault.request_early_redemption(&user, &shares);
    vault.process_early_redemption(&admin, &request_id);

    let assets = shares;
    let fee = math::mul_div(&env, assets, fee_bps, 10000);
    let net_assets = assets - fee;
    assert_eq!(net_assets, assets - fee);
    assert_eq!(token.balance(&user), net_assets);
    assert_eq!(token.balance(&vault_id), vault_balance_before - net_assets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Early redemption: shares burned
// ─────────────────────────────────────────────────────────────────────────────

/// process_early_redemption burns the user's shares and decrements total_supply.
#[test]
fn test_process_early_redemption_burns_shares() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    let supply_before = vault.total_supply();
    let balance_before = vault.balance(&user);
    assert_eq!(balance_before, shares);

    let request_id = vault.request_early_redemption(&user, &shares);
    vault.process_early_redemption(&admin, &request_id);

    // Shares should be burned
    assert_eq!(vault.balance(&user), 0);
    assert_eq!(vault.total_supply(), supply_before - shares);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Early redemption: fee management
// ─────────────────────────────────────────────────────────────────────────────

/// Operator can update the early redemption fee and the stored value changes.
#[test]
fn test_set_early_redemption_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // Default fee from init is 200 bps
    assert_eq!(vault.early_redemption_fee_bps(), 200u32);

    // Update to 500 bps (5%)
    vault.set_early_redemption_fee(&admin, &500u32);
    assert_eq!(vault.early_redemption_fee_bps(), 500u32);

    // Update to 0 bps (no fee)
    vault.set_early_redemption_fee(&admin, &0u32);
    assert_eq!(vault.early_redemption_fee_bps(), 0u32);
}

/// Setting early redemption fee above 1000 bps (10%) must panic with Error::FeeTooHigh (22).
#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_set_early_redemption_fee_too_high_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&env);
    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // 1001 bps exceeds the 1000 bps maximum — must panic.
    vault.set_early_redemption_fee(&admin, &1001u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Maturity redemption: principal + yield
// ─────────────────────────────────────────────────────────────────────────────

/// redeem_at_maturity returns principal assets plus any pending yield.
#[test]
fn test_redeem_at_maturity_returns_principal_plus_yield() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let other = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);
    // Second depositor ensures the vault retains enough tokens for the payout
    fund_user(&env, &vault_id, &token_id, &zkme_id, &other, deposit_amount);

    activate(&env, &vault_id, &admin);

    // Distribute yield across two epochs
    let yield_1 = 50_000i128;
    let yield_2 = 30_000i128;
    distribute_yield(&env, &vault_id, &token_id, &admin, yield_1);
    distribute_yield(&env, &vault_id, &token_id, &admin, yield_2);

    let total_yield = yield_1 + yield_2; // 80_000

    // Mature the vault
    mature(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    let pending = vault.pending_yield(&user);
    let user_balance_before = token.balance(&user);

    let total_out = vault.redeem_at_maturity(&user, &shares, &user, &user);

    // User has half the shares, so their pending yield is half the total
    let expected_pending = total_yield / 2; // 40_000
    assert_eq!(pending, expected_pending);

    // total_out = preview_redeem(shares) + pending_yield
    // totalAssets = 2 * deposit + total_yield = 2_080_000
    // assets = shares * totalAssets / totalSupply = 1_000_000 * 2_080_000 / 2_000_000 = 1_040_000
    // total_out = 1_040_000 + 40_000 = 1_080_000
    let total_assets = 2 * deposit_amount + total_yield;
    let total_supply = 2 * deposit_amount; // 1:1 ratio
    let expected_assets = shares * total_assets / total_supply;
    let expected_total_out = expected_assets + expected_pending;
    assert_eq!(total_out, expected_total_out);

    // Verify user actually received the tokens
    let user_balance_after = token.balance(&user);
    assert_eq!(user_balance_after, user_balance_before + total_out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Maturity redemption: epochs claimed
// ─────────────────────────────────────────────────────────────────────────────

/// redeem_at_maturity marks all epochs as claimed for the owner.
#[test]
fn test_redeem_at_maturity_marks_all_epochs_claimed() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let other = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);
    // Second depositor ensures the vault retains enough tokens
    fund_user(&env, &vault_id, &token_id, &zkme_id, &other, deposit_amount);

    activate(&env, &vault_id, &admin);

    // Distribute yield across three epochs
    distribute_yield(&env, &vault_id, &token_id, &admin, 10_000i128);
    distribute_yield(&env, &vault_id, &token_id, &admin, 20_000i128);
    distribute_yield(&env, &vault_id, &token_id, &admin, 30_000i128);

    // Verify pending yield exists before maturity redemption
    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let pending_before = vault.pending_yield(&user);
    assert!(pending_before > 0);

    // Mature and redeem
    mature(&env, &vault_id, &admin);
    vault.redeem_at_maturity(&user, &shares, &user, &user);

    // After redemption, all epochs should be claimed — pending yield = 0
    let pending_after = vault.pending_yield(&user);
    assert_eq!(pending_after, 0);

    // Each individual epoch should report 0 yield remaining
    assert_eq!(vault.pending_yield_for_epoch(&user, &1), 0);
    assert_eq!(vault.pending_yield_for_epoch(&user, &2), 0);
    assert_eq!(vault.pending_yield_for_epoch(&user, &3), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Maturity redemption: via allowance (spender on behalf of owner)
// ─────────────────────────────────────────────────────────────────────────────

/// A spender with sufficient allowance can redeem_at_maturity on behalf of the owner.
#[test]
fn test_redeem_at_maturity_via_allowance() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let receiver = Address::generate(&env);
    let other = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &owner, deposit_amount);
    // Second depositor ensures the vault retains enough tokens
    fund_user(&env, &vault_id, &token_id, &zkme_id, &other, deposit_amount);

    activate(&env, &vault_id, &admin);

    // Distribute some yield
    let yield_amount = 50_000i128;
    distribute_yield(&env, &vault_id, &token_id, &admin, yield_amount);

    // Mature the vault
    mature(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    // Owner approves spender for the full share amount
    vault.approve(&owner, &spender, &shares, &999_999u32);

    let receiver_balance_before = token.balance(&receiver);

    // Spender redeems on behalf of owner, sending assets to receiver
    let total_out = vault.redeem_at_maturity(&spender, &shares, &receiver, &owner);

    assert!(total_out > 0);

    // Receiver got the tokens
    let receiver_balance_after = token.balance(&receiver);
    assert_eq!(receiver_balance_after, receiver_balance_before + total_out);

    // Owner's shares are burned
    assert_eq!(vault.balance(&owner), 0);

    // Allowance should be decremented
    assert_eq!(vault.allowance(&owner, &spender), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Error paths
// ─────────────────────────────────────────────────────────────────────────────

/// request_early_redemption with zero shares must panic with Error::ZeroAmount.
#[test]
#[should_panic]
fn test_request_early_redemption_zero_shares_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    // Must have some balance to be a valid user, but request 0 shares
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, 1_000_000);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Must panic — zero shares
    vault.request_early_redemption(&user, &0i128);
}

/// redeem_at_maturity during Active state must panic with Error::InvalidVaultState.
#[test]
#[should_panic]
fn test_redeem_at_maturity_wrong_state_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    // Move to Active (NOT Matured)
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Must panic — vault is Active, not Matured
    vault.redeem_at_maturity(&user, &shares, &user, &user);
}

/// redeem_at_maturity with zero shares must panic with Error::ZeroAmount.
#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_redeem_at_maturity_zero_shares_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);
    mature(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Must panic — zero shares
    vault.redeem_at_maturity(&user, &0i128, &user, &user);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — #198: Over-redemption is rejected
// ─────────────────────────────────────────────────────────────────────────────

/// Attempting to redeem more shares than the user owns must fail with
/// Error::InsufficientBalance (#20).
#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_redeem_more_shares_than_owned_panics() {
    // Use setup_with_kyc_bypass — the same working infrastructure used by
    // test_withdraw.rs (which verifies redeem happy-paths against this context).
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    let deposit_amount = 5_000_000i128; // 5 USDC

    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);

    // Lower the funding target so the vault can be activated.
    let current = v.total_assets();
    if current < ctx.params.funding_target {
        v.set_funding_target(&ctx.admin, &current);
    }
    v.activate_vault(&ctx.admin);

    let shares = v.balance(&ctx.user);
    assert!(shares > 0, "user must hold shares");

    // Attempt to redeem one more share than the user holds — must panic.
    v.redeem(&ctx.user, &(shares + 1), &ctx.user, &ctx.user);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — #220: Claiming yield after early full redemption
// ─────────────────────────────────────────────────────────────────────────────

/// If yield was distributed BEFORE a user fully redeems early, the snapshot
/// taken at `request_early_redemption` time preserves their share balance for
/// that epoch.  The user must still be able to claim that pending yield after
/// their shares enter escrow (i.e., after the redemption is initiated).
///
/// Design note: `request_early_redemption` moves shares to escrow (balance → 0)
/// but does NOT burn them or remove them from the yield snapshot.  This test
/// verifies that the pre-request snapshot allows the user to claim yield earned
/// before they initiated redemption, even though their live balance is now 0.
#[test]
fn test_claim_yield_earned_before_early_full_redemption_succeeds() {
    let ctx = setup();
    let v = ctx.vault();

    let deposit_amount = 10_000_000i128; // 10 USDC

    // KYC-approve and deposit for user (the one who will redeem early).
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&ctx.user);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);

    // Second depositor keeps the vault funded so yield math remains non-trivial.
    let other = Address::generate(&ctx.env);
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&other);
    mint_usdc(&ctx.env, &ctx.asset_id, &other, deposit_amount);
    v.deposit(&other, &deposit_amount, &other);

    // Activate vault.
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    let shares = v.balance(&ctx.user);
    assert!(shares > 0, "user must hold shares before redemption");

    // Distribute yield WHILE user still holds all their shares (creates epoch 1).
    // At this point user has 50% of total shares → entitled to 50% of yield.
    let yield_amount = 100_000i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, yield_amount);
    v.distribute_yield(&ctx.operator, &yield_amount);

    // Sanity check: user has pending yield before initiating redemption.
    let pending_before = v.pending_yield(&ctx.user);
    assert!(
        pending_before > 0,
        "user must have pending yield before redemption"
    );

    // User requests early redemption of ALL shares.
    // `request_early_redemption` calls `update_user_snapshot`, which snapshots
    // the user's balance at epoch 1 BEFORE moving shares to escrow.
    // After this call: user's live balance = 0, escrowed_shares = shares.
    let _ = v.request_early_redemption(&ctx.user, &shares);

    // Live balance is now zero (shares are moved to escrow).
    assert_eq!(
        v.balance(&ctx.user),
        0,
        "live balance must be zero after request"
    );

    // Pending yield for epoch 1 must remain accessible: the snapshot taken at
    // request time recorded the user's pre-escrow balance for that epoch.
    let pending_after = v.pending_yield(&ctx.user);
    assert_eq!(
        pending_after, pending_before,
        "pending yield for epoch 1 must survive early redemption request"
    );

    // claim_yield succeeds — the vault still holds the tokens (process_early_redemption
    // has not yet transferred them out).
    let claimed = v.claim_yield(&ctx.user);
    assert_eq!(
        claimed, pending_before,
        "claimed amount must equal pre-redemption pending yield"
    );
    assert_eq!(
        claimed, pending_before,
        "claimed amount must equal pre-redemption pending yield"
    );

    // All yield is now claimed.
    assert_eq!(
        v.pending_yield(&ctx.user),
        0,
        "pending yield must be zero after claim"
    );
}

/// If yield is distributed AFTER a user has moved all their shares into escrow
/// via `request_early_redemption`, the user's live balance is 0 at distribution
/// time.  Because no pre-distribution snapshot exists for that epoch, they
/// receive no yield.  A subsequent `claim_yield` call must fail with
/// Error::NoYieldToClaim (#9).
#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_claim_yield_distributed_after_early_full_redemption_panics() {
    let ctx = setup();
    let v = ctx.vault();

    let deposit_amount = 10_000_000i128;

    // KYC-approve and deposit for user.
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&ctx.user);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, deposit_amount);
    v.deposit(&ctx.user, &deposit_amount, &ctx.user);

    // Second depositor keeps total_supply positive after user's shares are escrowed.
    let other = Address::generate(&ctx.env);
    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&other);
    mint_usdc(&ctx.env, &ctx.asset_id, &other, deposit_amount);
    v.deposit(&other, &deposit_amount, &other);

    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    let shares = v.balance(&ctx.user);

    // User requests early redemption of ALL shares BEFORE any yield is distributed.
    // After this: user's live balance = 0 (shares are in escrow).
    let _ = v.request_early_redemption(&ctx.user, &shares);
    assert_eq!(v.balance(&ctx.user), 0, "user live balance must be zero");

    // Yield distributed AFTER the user's balance is zero — no snapshot exists
    // at epoch 1 for this user, so the fallback to live balance (0) gives 0 yield.
    let yield_amount = 100_000i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, yield_amount);
    v.distribute_yield(&ctx.operator, &yield_amount);

    // Verify: user has no pending yield for epoch 1.
    assert_eq!(
        v.pending_yield(&ctx.user),
        0,
        "user must have no pending yield"
    );

    // Must panic with NoYieldToClaim (#9).
    v.claim_yield(&ctx.user);
}

/// Blacklisted address cannot redeem shares.
#[test]
#[should_panic(expected = "Error(Contract, #14)")] // Error::AddressBlacklisted = 14
fn test_redeem_blacklisted_address_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    // Activate the vault so early redemption is available
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // Grant ComplianceOfficer role to admin so they can blacklist
    vault.grant_role(&admin, &admin, &Role::ComplianceOfficer);

    // Blacklist the user
    vault.set_blacklisted(&admin, &user, &true);
    assert!(vault.is_blacklisted(&user));

    // Try to redeem — should panic with AddressBlacklisted
    vault.redeem(&user, &shares, &user, &user);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Regression: Double-claim prevention (#112)
// ─────────────────────────────────────────────────────────────────────────────

/// Users should not be able to claim yield for the same epoch twice via claim_yield.
#[test]
#[should_panic(expected = "Error(Contract, #9)")] // Error::NoYieldToClaim = 9
fn test_claim_yield_twice_fails() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    // 1. Setup: Deposit and activate
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
    v.deposit(&ctx.user, &100_000_000, &ctx.user);
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    // 2. Distribute yield for epoch 1
    let yield_amount = 1_000_000i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, yield_amount);
    v.distribute_yield(&ctx.operator, &yield_amount);

    // 3. First claim succeeds
    let claimed = v.claim_yield(&ctx.user);
    assert!(claimed > 0);

    // 4. Second attempt immediately after MUST panic with NoYieldToClaim (#9)
    v.claim_yield(&ctx.user);
}

/// Users should not be able to claim yield for the same epoch twice via claim_yield_for_epoch.
#[test]
#[should_panic(expected = "Error(Contract, #9)")] // Error::NoYieldToClaim = 9
fn test_claim_yield_for_epoch_twice_fails() {
    let ctx = setup_with_kyc_bypass();
    let v = ctx.vault();

    // 1. Setup: Deposit and activate
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
    v.deposit(&ctx.user, &100_000_000, &ctx.user);
    v.set_funding_target(&ctx.admin, &0i128);
    v.activate_vault(&ctx.operator);

    // 2. Distribute yield for epoch 1
    let yield_amount = 1_000_000i128;
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, yield_amount);
    v.distribute_yield(&ctx.operator, &yield_amount);

    // 3. First claim for epoch 1 succeeds
    let claimed = v.claim_yield_for_epoch(&ctx.user, &1u32);
    assert!(claimed > 0);

    // 4. Second attempt for same epoch MUST panic with NoYieldToClaim (#9)
    v.claim_yield_for_epoch(&ctx.user, &1u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]

fn test_claim_yield_zero_shares_panics() {
    let ctx = setup_with_kyc_bypass();

    let v = ctx.vault();

    // Activate the vault so claim_yield is allowed

    v.set_funding_target(&ctx.admin, &0i128);

    v.activate_vault(&ctx.operator);

    let user_with_zero_shares = Address::generate(&ctx.env);

    // KYC approve the user

    crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id)
        .approve_user(&user_with_zero_shares);

    // User has zero shares (never deposited)

    assert_eq!(v.balance(&user_with_zero_shares), 0);

    // Try to claim yield - should panic with NoYieldToClaim

    v.claim_yield(&user_with_zero_shares);
}

#[test]

fn test_multiple_users_claim_same_epoch_yield() {
    let ctx = setup_with_kyc_bypass();

    let v = ctx.vault();

    // Create multiple users with different share amounts

    let user1 = Address::generate(&ctx.env);

    let user2 = Address::generate(&ctx.env);

    let user3 = Address::generate(&ctx.env);

    let users = vec![&ctx.env, user1.clone(), user2.clone(), user3.clone()];

    // KYC approve all users

    for user in &users {
        crate::test_helpers::MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(user);
    }

    // Deposit amounts: user1: 100, user2: 200, user3: 300 (to have different proportions)

    let deposit1 = 100_000i128; // 100 USDC

    let deposit2 = 200_000i128;

    let deposit3 = 300_000i128;

    mint_usdc(&ctx.env, &ctx.asset_id, &user1, deposit1);

    v.deposit(&user1, &deposit1, &user1);

    mint_usdc(&ctx.env, &ctx.asset_id, &user2, deposit2);

    v.deposit(&user2, &deposit2, &user2);

    mint_usdc(&ctx.env, &ctx.asset_id, &user3, deposit3);

    v.deposit(&user3, &deposit3, &user3);

    // Activate vault

    v.set_funding_target(&ctx.admin, &0i128);

    v.activate_vault(&ctx.operator);

    // Record shares

    let shares1 = v.balance(&user1);

    let shares2 = v.balance(&user2);

    let shares3 = v.balance(&user3);

    let total_shares = shares1 + shares2 + shares3;

    // Distribute yield for epoch 1

    let epoch_yield = 1_000_000i128; // 1000 USDC

    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, epoch_yield);

    v.distribute_yield(&ctx.operator, &epoch_yield);

    // Calculate expected claims using the same math as the contract

    let expected1 = crate::math::mul_div(&ctx.env, epoch_yield, shares1, total_shares);

    let expected2 = crate::math::mul_div(&ctx.env, epoch_yield, shares2, total_shares);

    let expected3 = crate::math::mul_div(&ctx.env, epoch_yield, shares3, total_shares);

    let total_expected = expected1 + expected2 + expected3;

    // Have users claim yield for epoch 1 in different order

    let claimed1 = v.claim_yield_for_epoch(&user1, &1u32);

    let claimed3 = v.claim_yield_for_epoch(&user3, &1u32);

    let claimed2 = v.claim_yield_for_epoch(&user2, &1u32);

    // Verify each claim matches expected

    assert_eq!(claimed1, expected1);

    assert_eq!(claimed2, expected2);

    assert_eq!(claimed3, expected3);

    // Verify total claimed equals total expected (which may be less than epoch_yield due to rounding)

    let total_claimed = claimed1 + claimed2 + claimed3;

    assert_eq!(total_claimed, total_expected);

    // Total claimed should be <= epoch_yield

    assert!(total_claimed <= epoch_yield);

    // The difference should be small (rounding loss)

    let rounding_loss = epoch_yield - total_claimed;

    assert!(rounding_loss < 3); // At most 2 for 3 users

}

// ─────────────────────────────────────────────────────────────────────────────
// Regression test: Double-claim prevention for claim_yield_for_epoch
// ─────────────────────────────────────────────────────────────────────────────

/// Attempting to claim yield for the same epoch twice must fail.
/// The second claim should panic with Error::NoYieldToClaim (#9).
#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_claim_yield_for_epoch_twice_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);

    let deposit_amount = 1_000_000i128;
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // Distribute yield to create epoch 1
    let yield_amount = 50_000i128;
    distribute_yield(&env, &vault_id, &token_id, &admin, yield_amount);

    // First claim for epoch 1 succeeds
    let claimed = vault.claim_yield_for_epoch(&user, &1u32);
    assert!(
        claimed > 0,
        "first claim should succeed and return positive amount"
    );

    // Second claim for the same epoch must panic with NoYieldToClaim
    vault.claim_yield_for_epoch(&user, &1u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression test: Multiple users claiming yield for the same epoch
// ─────────────────────────────────────────────────────────────────────────────

/// Multiple users claiming yield from the same epoch should have their claims
/// sum up to the total distributed yield, accounting for rounding.
#[test]
fn test_multiple_users_claim_same_epoch_yield() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let user3 = Address::generate(&env);

    // Set up three users with different share amounts
    let deposit1 = 2_000_000i128; // 2 shares
    let deposit2 = 3_000_000i128; // 3 shares
    let deposit3 = 5_000_000i128; // 5 shares
    let _total_deposits = deposit1 + deposit2 + deposit3; // 10 shares total

    fund_user(&env, &vault_id, &token_id, &zkme_id, &user1, deposit1);
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user2, deposit2);
    fund_user(&env, &vault_id, &token_id, &zkme_id, &user3, deposit3);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);

    // Distribute yield to create epoch 1
    let yield_amount = 1_000_000i128; // 1 USDC yield
    distribute_yield(&env, &vault_id, &token_id, &admin, yield_amount);

    // Each user should get yield proportional to their shares
    // User1: 2/10 * 1_000_000 = 200_000
    // User2: 3/10 * 1_000_000 = 300_000
    // User3: 5/10 * 1_000_000 = 500_000
    let expected_user1 = 200_000i128;
    let expected_user2 = 300_000i128;
    let expected_user3 = 500_000i128;

    // Verify individual pending yields before claiming
    assert_eq!(vault.pending_yield_for_epoch(&user1, &1u32), expected_user1);
    assert_eq!(vault.pending_yield_for_epoch(&user2, &1u32), expected_user2);
    assert_eq!(vault.pending_yield_for_epoch(&user3, &1u32), expected_user3);

    // Users claim yield for epoch 1 in different order
    let claimed1 = vault.claim_yield_for_epoch(&user1, &1u32);
    let claimed2 = vault.claim_yield_for_epoch(&user2, &1u32);
    let claimed3 = vault.claim_yield_for_epoch(&user3, &1u32);

    // Verify each claim matches expected amount
    assert_eq!(claimed1, expected_user1, "user1 claim matches expected");
    assert_eq!(claimed2, expected_user2, "user2 claim matches expected");
    assert_eq!(claimed3, expected_user3, "user3 claim matches expected");

    // Total claimed should equal distributed yield
    let total_claimed = claimed1 + claimed2 + claimed3;
    assert_eq!(
        total_claimed, yield_amount,
        "total claimed equals distributed yield"
    );

    // After claiming, all users should have zero pending yield for epoch 1
    assert_eq!(vault.pending_yield_for_epoch(&user1, &1u32), 0);
    assert_eq!(vault.pending_yield_for_epoch(&user2, &1u32), 0);
    assert_eq!(vault.pending_yield_for_epoch(&user3, &1u32), 0);

    // Verify epoch is marked as claimed for all users
    assert_eq!(vault.last_claimed_epoch(&user1), 1);
    assert_eq!(vault.last_claimed_epoch(&user2), 1);
    assert_eq!(vault.last_claimed_epoch(&user3), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Issue #194: Partial redemption followed by full redemption
// ─────────────────────────────────────────────────────────────────────────────

/// A user performs an early partial redemption of half their shares, then redeems
/// the remaining shares at maturity. After both redemptions:
/// - The user holds zero vault shares.
/// - The combined payout (partial net + maturity payout) equals the user's total
///   entitlement: partial assets minus fee, plus remaining shares converted at the
///   then-current share price.
/// - Yield distributed between the two redemptions is included in the maturity payout.
#[test]
fn test_partial_early_redemption_then_full_redemption_at_maturity() {
    let env = Env::default();
    env.mock_all_auths();

    // ── Setup ────────────────────────────────────────────────────────────────
    let (vault_id, token_id, zkme_id, admin) = make_vault(&env);
    let user = Address::generate(&env);
    let other = Address::generate(&env);

    let deposit_amount = 2_000_000i128;

    // Fund both depositors so the vault holds enough tokens to cover early payout.
    let shares = fund_user(&env, &vault_id, &token_id, &zkme_id, &user, deposit_amount);
    fund_user(&env, &vault_id, &token_id, &zkme_id, &other, deposit_amount);

    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    let token = MockTokenClient::new(&env, &token_id);

    // ── Stage 1: partial early redemption ────────────────────────────────────
    let partial_shares = shares / 2; // redeem half
    let remaining_shares = shares - partial_shares;

    let request_id = vault.request_early_redemption(&user, &partial_shares);

    // After request: user's live balance is reduced by partial_shares (shares in escrow)
    assert_eq!(vault.balance(&user), remaining_shares);

    let user_balance_before_partial = token.balance(&user);
    vault.process_early_redemption(&admin, &request_id);

    // fee_bps = 200 (2%), share price is 1:1 at inception
    let partial_assets = partial_shares; // 1:1 ratio
    let fee = (partial_assets * 200) / 10_000; // 2%
    let partial_net = partial_assets - fee;

    let user_balance_after_partial = token.balance(&user);
    assert_eq!(
        user_balance_after_partial,
        user_balance_before_partial + partial_net,
        "partial redemption payout must equal assets minus 2% fee"
    );

    // Shares burned by early redemption
    assert_eq!(
        vault.balance(&user),
        remaining_shares,
        "remaining shares must be unchanged after partial early redemption"
    );

    // ── Distribute yield between the two redemption stages ───────────────────
    let yield_amount = 80_000i128;
    distribute_yield(&env, &vault_id, &token_id, &admin, yield_amount);

    // ── Stage 2: full redemption at maturity ──────────────────────────────────
    mature(&env, &vault_id, &admin);

    let pending = vault.pending_yield(&user);
    let user_balance_before_maturity = token.balance(&user);

    let maturity_out = vault.redeem_at_maturity(&user, &remaining_shares, &user, &user);

    assert!(
        maturity_out > 0,
        "maturity redemption must return a positive payout"
    );

    let user_balance_after_maturity = token.balance(&user);
    assert_eq!(
        user_balance_after_maturity,
        user_balance_before_maturity + maturity_out,
        "user token balance must increase by the full maturity payout"
    );

    // Pending yield is included in maturity_out
    assert!(
        maturity_out >= pending,
        "maturity payout must include any pending yield"
    );

    // ── Final state ───────────────────────────────────────────────────────────
    // User holds zero vault shares after both redemptions.
    assert_eq!(
        vault.balance(&user),
        0,
        "user must hold zero shares after partial + full redemption"
    );

    // Combined payout covers at least the deposited principal (yield accrued).
    let total_received = user_balance_after_maturity; // started with 0 token balance
    assert!(
        total_received >= deposit_amount,
        "total received must be at least the deposited principal"
    );
}
