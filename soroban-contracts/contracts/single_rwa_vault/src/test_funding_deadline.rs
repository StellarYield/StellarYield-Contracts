//! Tests for funding_deadline, cancel_funding, and refund (issue #31).

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient, VaultState};

use crate::test_helpers::{AlwaysApproveZkme, MockUsdc, MockUsdcClient};

// ─────────────────────────────────────────────────────────────────────────────
// Test context with configurable funding_deadline and no deposit cap
// ─────────────────────────────────────────────────────────────────────────────

struct Ctx {
    env: Env,
    vault_id: Address,
    asset_id: Address,
    admin: Address,
    user: Address,
}

impl Ctx {
    fn vault(&self) -> SingleRWAVaultClient<'_> {
        SingleRWAVaultClient::new(&self.env, &self.vault_id)
    }
    fn asset(&self) -> MockUsdcClient<'_> {
        MockUsdcClient::new(&self.env, &self.asset_id)
    }
}

/// Deploy a fresh vault with the given `funding_deadline`.
/// Funding target = 100 USDC; max_deposit_per_user = 0 (unlimited).
fn deploy(funding_deadline: u64) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let cooperator = Address::generate(&env);

    let asset_id = env.register(MockUsdc, ());
    let kyc_id = env.register(AlwaysApproveZkme, ());

    let params = InitParams {
        asset: asset_id.clone(),
        share_name: String::from_str(&env, "StellarYield Bond Share"),
        share_symbol: String::from_str(&env, "syBOND"),
        share_decimals: 6u32,
        admin: admin.clone(),
        zkme_verifier: kyc_id.clone(),
        cooperator: cooperator.clone(),
        funding_target: 100_000_000i128, // 100 USDC
        maturity_date: 9_999_999_999u64,
        funding_deadline,
        min_deposit: 1_000_000i128,  // 1 USDC
        max_deposit_per_user: 0i128, // unlimited
        early_redemption_fee_bps: 200u32,
        lock_up_period: 0u64,
        rwa_name: String::from_str(&env, "US Treasury Bond 2026"),
        rwa_symbol: String::from_str(&env, "USTB26"),
        rwa_document_uri: String::from_str(&env, "https://example.com/ustb26"),
        rwa_category: String::from_str(&env, "Government Bond"),
        expected_apy: 500u32,
    };

    let vault_id = env.register(SingleRWAVault, (params,));
    Ctx {
        env,
        vault_id,
        asset_id,
        admin,
        user,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: funding_deadline is stored and queryable at construction
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_funding_deadline_stored_at_construction() {
    let deadline = 1_700_000_000u64;
    let ctx = deploy(deadline);
    assert_eq!(ctx.vault().funding_deadline(), deadline);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: zero deadline means "no deadline" — activate_vault is unaffected
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_zero_deadline_means_no_deadline() {
    let ctx = deploy(0);
    let vault = ctx.vault();

    ctx.asset().mint(&ctx.user, &100_000_000i128);
    vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);

    // Large timestamp advance — deadline = 0 should not block activation
    ctx.env.ledger().with_mut(|li| li.timestamp = 9_999_999u64);
    vault.activate_vault(&ctx.admin);
    assert_eq!(vault.vault_state(), VaultState::Active);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: activate_vault succeeds before deadline when target is met
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_activate_vault_succeeds_before_deadline() {
    let ctx = deploy(9_999_999_999u64);
    let vault = ctx.vault();

    ctx.asset().mint(&ctx.user, &100_000_000i128);
    vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);

    vault.activate_vault(&ctx.admin);
    assert_eq!(vault.vault_state(), VaultState::Active);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: activate_vault fails after deadline  (Error::FundingDeadlinePassed = 16)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_activate_vault_fails_after_deadline() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    ctx.asset().mint(&ctx.user, &100_000_000i128);
    vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);

    // Advance past deadline then attempt activation.
    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.activate_vault(&ctx.admin); // must panic with Error #16
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: cancel_funding fails before deadline  (Error::FundingDeadlineNotPassed = 17)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_cancel_funding_fails_before_deadline() {
    let ctx = deploy(9_999_999_999u64); // deadline far in the future
    ctx.asset().mint(&ctx.user, &10_000_000i128);
    ctx.vault().deposit(&ctx.user, &10_000_000i128, &ctx.user);
    ctx.vault().cancel_funding(&ctx.admin); // must panic with Error #17
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: cancel_funding with zero deadline also fails  (no deadline configured)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_cancel_funding_fails_when_no_deadline() {
    let ctx = deploy(0); // deadline = 0 means "no deadline"
    ctx.vault().cancel_funding(&ctx.admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: cancel_funding fails when funding target IS met after deadline
// (Error::FundingTargetNotMet = 10 re-used to mean "target was met, can't cancel")
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_cancel_funding_fails_when_target_met() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    // Meet the funding target.
    ctx.asset().mint(&ctx.user, &100_000_000i128);
    vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);

    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&ctx.admin); // must panic — target met
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: cancel_funding transitions to Cancelled state
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_cancel_funding_sets_cancelled_state() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    // Deposit some (but not enough to meet target).
    ctx.asset().mint(&ctx.user, &10_000_000i128);
    vault.deposit(&ctx.user, &10_000_000i128, &ctx.user);

    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&ctx.admin);

    assert_eq!(vault.vault_state(), VaultState::Cancelled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: full cancel-refund flow — two users each get their deposit back
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_full_cancel_and_refund_flow() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    let user2 = Address::generate(&ctx.env);

    // Each user deposits 10 USDC (total = 20 USDC < 100 USDC target).
    ctx.asset().mint(&ctx.user, &10_000_000i128);
    ctx.asset().mint(&user2, &10_000_000i128);
    vault.deposit(&ctx.user, &10_000_000i128, &ctx.user);
    vault.deposit(&user2, &10_000_000i128, &user2);

    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&ctx.admin);
    assert_eq!(vault.vault_state(), VaultState::Cancelled);

    // User 1 refunds.
    let bal_before = ctx.asset().balance(&ctx.user);
    let returned = vault.refund(&ctx.user);
    let bal_after = ctx.asset().balance(&ctx.user);
    assert_eq!(returned, 10_000_000i128);
    assert_eq!(bal_after - bal_before, 10_000_000i128);
    assert_eq!(vault.balance(&ctx.user), 0);

    // User 2 refunds.
    let bal2_before = ctx.asset().balance(&user2);
    let returned2 = vault.refund(&user2);
    let bal2_after = ctx.asset().balance(&user2);
    assert_eq!(returned2, 10_000_000i128);
    assert_eq!(bal2_after - bal2_before, 10_000_000i128);
    assert_eq!(vault.balance(&user2), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: refund fails when vault is not Cancelled  (Error #5 = InvalidVaultState)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_refund_fails_when_vault_not_cancelled() {
    let ctx = deploy(9_999_999_999u64);
    ctx.asset().mint(&ctx.user, &10_000_000i128);
    ctx.vault().deposit(&ctx.user, &10_000_000i128, &ctx.user);
    ctx.vault().refund(&ctx.user); // must panic — not Cancelled
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: refund fails when caller has no shares  (Error #18 = NoSharesToRefund)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_refund_fails_when_no_shares() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    ctx.asset().mint(&ctx.user, &10_000_000i128);
    vault.deposit(&ctx.user, &10_000_000i128, &ctx.user);

    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&ctx.admin);

    let stranger = Address::generate(&ctx.env);
    vault.refund(&stranger); // must panic — no shares
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: cannot double-refund  (Error #18 = NoSharesToRefund on second call)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_cannot_double_refund() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    ctx.asset().mint(&ctx.user, &10_000_000i128);
    vault.deposit(&ctx.user, &10_000_000i128, &ctx.user);

    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&ctx.admin);

    vault.refund(&ctx.user); // first — ok
    vault.refund(&ctx.user); // second — must panic
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: only operator can cancel_funding  (Error #3 = NotOperator)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_cancel_funding_requires_operator() {
    let deadline = 1_000u64;
    let ctx = deploy(deadline);
    let vault = ctx.vault();

    ctx.asset().mint(&ctx.user, &10_000_000i128);
    vault.deposit(&ctx.user, &10_000_000i128, &ctx.user);

    ctx.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    vault.cancel_funding(&ctx.user); // non-operator — must panic
}
