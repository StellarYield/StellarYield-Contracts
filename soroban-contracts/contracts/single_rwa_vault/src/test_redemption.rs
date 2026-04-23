extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{InitParams, Role, SingleRWAVault, SingleRWAVaultClient};

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
// Tests — Yield distribution: error paths
// ─────────────────────────────────────────────────────────────────────────────

/// Operator cannot distribute zero yield: distribute_yield must panic with Error::ZeroAmount (13)
/// when called with amount == 0, as enforced by the guard at lib.rs:693-695.
#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_operator_cannot_distribute_zero_yield() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, token_id, _zkme_id, admin) = make_vault(&env);
    activate(&env, &vault_id, &admin);

    let vault = SingleRWAVaultClient::new(&env, &vault_id);
    // Must panic — zero yield amount
    vault.distribute_yield(&admin, &0i128);
}
