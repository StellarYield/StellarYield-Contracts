//! Tests for claim_yield insufficient balance scenarios (#127).

extern crate std;

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{symbol_short, Address, IntoVal};

use crate::test_helpers::{mint_usdc, setup_with_fee_on_transfer_asset, setup_with_kyc_bypass};

const FUNDING_TARGET: i128 = 100_000_000;

fn activated_ctx(extra_operator_budget: i128) -> crate::test_helpers::TestContext {
    let ctx = setup_with_kyc_bypass();
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, FUNDING_TARGET);
    mint_usdc(
        &ctx.env,
        &ctx.asset_id,
        &ctx.operator,
        extra_operator_budget,
    );
    ctx.vault().deposit(&ctx.user, &FUNDING_TARGET, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);
    ctx
}

fn dist(ctx: &crate::test_helpers::TestContext, amount: i128) {
    ctx.vault().distribute_yield(&ctx.operator, &amount);
}

/// Helper: Drain funds from the vault to create a shortfall scenario.
/// Uses `mock_all_auths()` to force transfer from vault directly.
fn drain_vault(ctx: &crate::test_helpers::TestContext, amount: i128) {
    let dummy = Address::generate(&ctx.env);
    ctx.asset().transfer(&ctx.vault_id, &dummy, &amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// claim_yield — Insufficient Balance Scenarios
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_partial_claim_shortfall_recorded() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000); // User is entitled to 20_000

    // Drain 5_000 from vault, leaving 15_000 for yield
    // Note: total vault balance = 100_000_000 (deposit) + 20_000 (yield) = 100_020_000
    // To leave only 15_000 actual vault balance, we must drain down to 15_000...
    // Wait, the deposit is in the vault too!
    // So if the user claims yield, the vault has plenty of balance from deposits!
    // Ah, `claim_yield` uses `asset_balance_of_vault(e)`, which is TOTAL balance.
    // If the vault has deposit balance, it will use that for yield? Yes, the contract design implies that.
    // To truly create a shortfall, we must drain the vault's total balance.
    // Let's drain (FUNDING_TARGET + 5_000). Total in vault: 100_020_000.
    // Drain 100_005_000, leaving 15_000.
    drain_vault(&ctx, FUNDING_TARGET + 5_000);

    let _pre_claim_balance_user = ctx.asset().balance(&ctx.user);

    // Wrap to capture panic
    let transferred = ctx.vault().claim_yield(&ctx.user);
    let all_events = ctx.env.events().all();

    assert_eq!(transferred, 15_000, "Should only transfer available 15_000");

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall, 5_000, "Shortfall should be recorded as 5_000");

    let mut found = false;
    for evt in all_events.iter() {
        if evt.0 == ctx.vault_id && evt.1.len() > 0 {
            let sym: soroban_sdk::Symbol = evt.1.get_unchecked(0).into_val(&ctx.env);
            if sym == symbol_short!("prt_yld") {
                found = true;
                break;
            }
        }
    }
    assert!(found, "Partial yield claim event should be emitted");

    // Epochs should be marked as claimed
    assert_eq!(
        ctx.vault().pending_yield(&ctx.user),
        0,
        "All pending yield should be cleared"
    );
}

#[test]
fn test_partial_claim_accumulates() {
    let ctx = activated_ctx(40_000);
    dist(&ctx, 20_000);

    // Drain down to 10_000 (total = 100_020_000)
    drain_vault(&ctx, FUNDING_TARGET + 10_000);
    ctx.vault().claim_yield(&ctx.user); // Claims 10_000, short 10_000

    let shortfall1 = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall1, 10_000);

    // More yield distributed
    dist(&ctx, 20_000); // total yield pending: 20_000. Vault has 0 + 20_000 = 20_000.
                        // Drain down to 5_000
    drain_vault(&ctx, 15_000);
    ctx.vault().claim_yield(&ctx.user); // Claims 5_000, short 15_000

    let shortfall2 = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall2, 10_000 + 15_000, "Shortfall should accumulate");
}

#[test]
fn test_full_claim_no_shortfall() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);

    // Full balance available
    let transferred = ctx.vault().claim_yield(&ctx.user);
    assert_eq!(transferred, 20_000);

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall, 0, "No shortfall should be recorded");

    // Check no partial event
    let events = ctx.env.events().all();
    let partial_claim_event = events.iter().find(|evt| {
        evt.0 == ctx.vault_id && evt.1.contains(&symbol_short!("prt_yld").into_val(&ctx.env))
    });
    assert!(
        partial_claim_event.is_none(),
        "No partial yield claim event should be emitted"
    );
}

#[test]
fn test_zero_vault_balance() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);

    // Drain entirely
    drain_vault(&ctx, FUNDING_TARGET + 20_000);

    let pre_claim_balance_user = ctx.asset().balance(&ctx.user);
    let transferred = ctx.vault().claim_yield(&ctx.user);
    assert_eq!(transferred, 0);
    assert_eq!(ctx.asset().balance(&ctx.user), pre_claim_balance_user);

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall, 20_000, "Shortfall should be full");

    assert_eq!(
        ctx.vault().pending_yield(&ctx.user),
        0,
        "Epochs still marked as claimed"
    );
}

#[test]
fn test_rounding_accumulation_across_many_users() {
    let ctx = setup_with_kyc_bypass();
    let user1 = Address::generate(&ctx.env);
    let user2 = Address::generate(&ctx.env);
    let user3 = Address::generate(&ctx.env);

    mint_usdc(&ctx.env, &ctx.asset_id, &user1, 33_333_333);
    mint_usdc(&ctx.env, &ctx.asset_id, &user2, 33_333_333);
    mint_usdc(&ctx.env, &ctx.asset_id, &user3, 33_333_334); // total 100_000_000

    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 10_000);

    ctx.vault().deposit(&user1, &33_333_333, &user1);
    ctx.vault().deposit(&user2, &33_333_333, &user2);
    ctx.vault().deposit(&user3, &33_333_334, &user3);
    ctx.vault().activate_vault(&ctx.operator);

    // Drain the deposit balance so that ONLY yield tokens are left, to accurately test rounding
    drain_vault(&ctx, 100_000_000);

    dist(&ctx, 10_000);

    // With floor division, user1 and 2 get 3333, user3 gets 3333.
    // We want the sum of computed yields to EXCEED the vault balance.
    // Wait, floor division ensures sum of computed yields is <= distributed.
    // If we want it to exceed, maybe the vault received less than distributed, or maybe
    // we use `claim_yield` and manually adjust. The rules say "proportional math such that the sum of computed yields slightly exceeds the vault balance".
    // Floor division won't exceed. But we can drain 1 token from the vault to cause 1 user to hit a deficit!
    // Total balance = 10,000.
    // Drain 2, so only 9998 is available.
    drain_vault(&ctx, 2);

    ctx.vault().claim_yield(&user1); // Expect 3333, Balance 9998 -> 6665
    ctx.vault().claim_yield(&user2); // Expect 3333, Balance 6665 -> 3332
    let transferred3 = ctx.vault().claim_yield(&user3); // Expect 3333, Balance 3332 -> 0. Transferred = 3332.

    assert_eq!(transferred3, 3332);

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &user3)
    });
    assert_eq!(shortfall, 1);
    assert_eq!(ctx.asset().balance(&ctx.vault_id), 0);
}

#[test]
fn test_deflationary_token_simulation() {
    let ctx = setup_with_fee_on_transfer_asset(100); // 1% fee on transfer

    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, FUNDING_TARGET);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 10_000);

    ctx.vault().deposit(&ctx.user, &FUNDING_TARGET, &ctx.user);
    ctx.vault().activate_vault(&ctx.operator);

    // Initial deposit took a 1% fee. Vault has 99_000_000 deposited.
    // Distribute 10_000, 1% fee -> 9_900 enters vault.
    ctx.vault().distribute_yield(&ctx.operator, &10_000);

    // To hit shortfall, the total balance (99_000_000 + 9_900) must be less than 10_000.
    // But deposit is pooled! Vault balance is ~99_009_900.
    // So we drain deposit balance to expose the shortfall.
    drain_vault(&ctx, 99_000_000);

    let transferred = ctx.vault().claim_yield(&ctx.user);
    // User expects 10_000, but vault only has 9_900.
    // Vault transferring 9_900 to user also incurs 1% fee, so user receives 9_801. But `transferred` returns the vault's side.
    assert_eq!(transferred, 9_900);

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// resolve_yield_shortfall Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_resolve_full() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);
    drain_vault(&ctx, FUNDING_TARGET + 5_000); // leaves 15_000
    ctx.vault().claim_yield(&ctx.user);

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(shortfall, 5_000);

    // Top up vault
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 5_000);
    ctx.asset().transfer(&ctx.operator, &ctx.vault_id, &5_000);

    let pre_balance = ctx.asset().balance(&ctx.user);

    let _ = ctx.vault()
        .resolve_yield_shortfall(&ctx.operator, &ctx.user, &5_000);
    let all_events = ctx.env.events().all();

    assert_eq!(ctx.asset().balance(&ctx.user), pre_balance + 5_000);

    let remaining = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(remaining, 0);

    let resolved_evt = all_events.iter().find(|evt| {
        if evt.0 != ctx.vault_id || evt.1.len() == 0 {
            return false;
        }
        let sym: soroban_sdk::Symbol = evt.1.get_unchecked(0).into_val(&ctx.env);
        sym == symbol_short!("ys_res")
    });
    assert!(resolved_evt.is_some());
}

#[test]
fn test_resolve_partial() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);
    drain_vault(&ctx, FUNDING_TARGET + 5_000); // leaves 15_000
    ctx.vault().claim_yield(&ctx.user);

    // Top up vault
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.operator, 5_000);
    ctx.asset().transfer(&ctx.operator, &ctx.vault_id, &5_000);

    ctx.vault()
        .resolve_yield_shortfall(&ctx.operator, &ctx.user, &2_000);

    let remaining = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(remaining, 3_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // NotOperator
fn test_resolve_unauthorised() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);
    drain_vault(&ctx, FUNDING_TARGET + 5_000);
    ctx.vault().claim_yield(&ctx.user);

    ctx.vault()
        .resolve_yield_shortfall(&ctx.user, &ctx.user, &5_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #50)")] // ShfNo
fn test_resolve_zero_shortfall() {
    let ctx = activated_ctx(20_000);
    ctx.vault()
        .resolve_yield_shortfall(&ctx.operator, &ctx.user, &5_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #51)")] // InsfShf
fn test_resolve_amount_exceeds_shortfall() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);
    drain_vault(&ctx, FUNDING_TARGET + 5_000);
    ctx.vault().claim_yield(&ctx.user);

    ctx.vault()
        .resolve_yield_shortfall(&ctx.operator, &ctx.user, &6_000);
}

#[test]
#[should_panic(expected = "insufficient token balance")]
fn test_resolve_insufficient_vault_balance() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);
    drain_vault(&ctx, FUNDING_TARGET + 5_000); // leaves 15_000
    ctx.vault().claim_yield(&ctx.user); // generates 5_000 shortfall

    drain_vault(&ctx, 15_000); // vault balance 0

    // Should crash as the token transfer reverts
    ctx.vault()
        .resolve_yield_shortfall(&ctx.operator, &ctx.user, &5_000);
}

// Ensure vacuous checks aren't missed:
#[test]
fn test_vacuous_checks_negative_auth() {
    let ctx = activated_ctx(20_000);
    dist(&ctx, 20_000);
    drain_vault(&ctx, FUNDING_TARGET + 5_000);
    ctx.vault().claim_yield(&ctx.user);

    let shortfall = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });

    assert!(shortfall > 0);

    // Call unauthorized
    let res = ctx.env.try_invoke_contract::<(), crate::errors::Error>(
        &ctx.vault_id,
        &soroban_sdk::Symbol::new(&ctx.env, "resolve_yield_shortfall"),
        (ctx.user.clone(), ctx.user.clone(), 5_000i128).into_val(&ctx.env),
    );
    assert!(res.is_err(), "Must reject non-operator");

    let shortfall_after = ctx.env.as_contract(&ctx.vault_id, || {
        crate::storage::get_yield_shortfall(&ctx.env, &ctx.user)
    });
    assert_eq!(
        shortfall, shortfall_after,
        "Shortfall must reflect no changes on revert"
    );
}
