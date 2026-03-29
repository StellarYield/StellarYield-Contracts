//! Tests asserting that key vault actions emit the expected events.
//!
//! Covers issues:
//!   #215 — Deposit, withdraw, and yield distribution should emit specific events.
//!
//! Each test:
//!   1. Performs an action (deposit / withdraw / distribute_yield).
//!   2. Inspects `env.events().all()` for an event originating from the vault contract.
//!   3. Asserts that the topic symbol and address/data fields match the current
//!      schema defined in `events.rs`.
//!
//! No production code is changed by these tests.

extern crate std;

use soroban_sdk::{symbol_short, testutils::Events as _, IntoVal};

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass, TestContext};

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers (mirror pattern used in test_withdraw.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// Mint `assets` to `user` and deposit into the vault, returning shares minted.
fn deposit(ctx: &TestContext, user: &soroban_sdk::Address, assets: i128) -> i128 {
    mint_usdc(&ctx.env, &ctx.asset_id, user, assets);
    ctx.vault().deposit(user, &assets, user)
}

/// Lower the funding target to match current assets (if needed) and activate.
fn activate(ctx: &TestContext) {
    let current = ctx.vault().total_assets();
    if current < ctx.params.funding_target {
        ctx.vault().set_funding_target(&ctx.admin, &current);
    }
    ctx.vault().activate_vault(&ctx.admin);
}

/// Mint `amount` yield tokens to the admin and distribute them to the vault.
/// Returns the new epoch number.
fn distribute_yield(ctx: &TestContext, amount: i128) -> u32 {
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, amount);
    ctx.vault().distribute_yield(&ctx.admin, &amount)
}

// ─────────────────────────────────────────────────────────────────────────────
// #215 — deposit emits an event with "deposit" topic, correct address topics,
//         and correct (assets, shares) data.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_deposit_emits_event_with_correct_schema() {
    let ctx = setup_with_kyc_bypass();
    let deposit_amount = 5_000_000i128; // 5 USDC (6 decimals)

    let shares = deposit(&ctx, &ctx.user.clone(), deposit_amount);

    // ── Locate the "deposit" event emitted by the vault contract ──────────────
    let events = ctx.env.events().all();
    let deposit_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("deposit")
        }
    });
    let (_, topics, data) = deposit_event.expect("deposit event must be emitted");

    // ── Topic verification: (symbol, caller, receiver) ────────────────────────
    let topic_caller: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    let topic_receiver: soroban_sdk::Address = topics.get_unchecked(2).into_val(&ctx.env);
    assert_eq!(
        topic_caller, ctx.user,
        "deposit event: caller topic must match depositor"
    );
    assert_eq!(
        topic_receiver, ctx.user,
        "deposit event: receiver topic must match depositor"
    );

    // ── Data verification: (assets: i128, shares: i128) ──────────────────────
    let (event_assets, event_shares): (i128, i128) = data.into_val(&ctx.env);
    assert_eq!(
        event_assets, deposit_amount,
        "deposit event: assets data must match deposit amount"
    );
    assert_eq!(
        event_shares, shares,
        "deposit event: shares data must match minted shares"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// #215 — withdraw emits an event with "withdraw" topic, correct address topics,
//         and correct (assets, shares) data.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_emits_event_with_correct_schema() {
    let ctx = setup_with_kyc_bypass();
    let deposit_amount = 10_000_000i128; // 10 USDC
    let withdraw_amount = 4_000_000i128; // 4 USDC

    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    let shares_burned = ctx
        .vault()
        .withdraw(&ctx.user, &withdraw_amount, &ctx.user, &ctx.user);

    // ── Locate the "withdraw" event emitted by the vault contract ─────────────
    let events = ctx.env.events().all();
    let withdraw_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("withdraw")
        }
    });
    let (_, topics, data) = withdraw_event.expect("withdraw event must be emitted");

    // ── Topic verification: (symbol, caller, receiver, owner) ─────────────────
    let topic_caller: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    let topic_receiver: soroban_sdk::Address = topics.get_unchecked(2).into_val(&ctx.env);
    let topic_owner: soroban_sdk::Address = topics.get_unchecked(3).into_val(&ctx.env);
    assert_eq!(
        topic_caller, ctx.user,
        "withdraw event: caller topic must match"
    );
    assert_eq!(
        topic_receiver, ctx.user,
        "withdraw event: receiver topic must match"
    );
    assert_eq!(
        topic_owner, ctx.user,
        "withdraw event: owner topic must match"
    );

    // ── Data verification: (assets: i128, shares: i128) ──────────────────────
    let (event_assets, event_shares): (i128, i128) = data.into_val(&ctx.env);
    assert_eq!(
        event_assets, withdraw_amount,
        "withdraw event: assets data must match withdrawn amount"
    );
    assert_eq!(
        event_shares, shares_burned,
        "withdraw event: shares data must match burned shares"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// #215 — distribute_yield emits an event with "yield_dis" topic, correct epoch
//         topic, and correct (amount, timestamp) data.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_distribute_yield_emits_event_with_correct_schema() {
    let ctx = setup_with_kyc_bypass();
    let deposit_amount = 10_000_000i128; // 10 USDC
    let yield_amount = 500_000i128; // 0.5 USDC yield

    deposit(&ctx, &ctx.user.clone(), deposit_amount);
    activate(&ctx);

    let epoch = distribute_yield(&ctx, yield_amount);

    // ── Locate the "yield_dis" event emitted by the vault contract ────────────
    let events = ctx.env.events().all();
    let yield_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("yield_dis")
        }
    });
    let (_, topics, data) = yield_event.expect("yield_distributed event must be emitted");

    // ── Topic verification: (symbol, epoch: u32) ─────────────────────────────
    let topic_epoch: u32 = topics.get_unchecked(1).into_val(&ctx.env);
    assert_eq!(
        topic_epoch, epoch,
        "yield_distributed event: epoch topic must match returned epoch"
    );

    // ── Data verification: (amount: i128, timestamp: u64) ────────────────────
    let (event_amount, _event_timestamp): (i128, u64) = data.into_val(&ctx.env);
    assert_eq!(
        event_amount, yield_amount,
        "yield_distributed event: amount data must match distributed yield"
    );
}
