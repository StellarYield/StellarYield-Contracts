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

use soroban_sdk::{symbol_short, testutils::Address as _, testutils::Events as _, IntoVal};

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

#[test]
fn test_transfer_exemption_set_emits_event_with_correct_schema() {
    let ctx = setup_with_kyc_bypass();
    let market_maker = soroban_sdk::Address::generate(&ctx.env);

    ctx.vault()
        .set_transfer_exempt(&ctx.admin, &market_maker, &true);

    let events = ctx.env.events().all();
    let exemption_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("xfer_exm")
        }
    });
    let (_, topics, data) = exemption_event.expect("transfer exemption event must be emitted");

    let topic_address: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    assert_eq!(
        topic_address, market_maker,
        "transfer exemption event: address topic must match"
    );

    let exempt: bool = data.into_val(&ctx.env);
    assert!(exempt, "transfer exemption event: data must match status");
}

#[test]
fn test_set_zkme_verifier_emits_event_with_caller_and_addresses() {
    let ctx = setup_with_kyc_bypass();
    let new_verifier = soroban_sdk::Address::generate(&ctx.env);
    let old_verifier = ctx.vault().zkme_verifier();

    ctx.vault().set_zkme_verifier(&ctx.admin, &new_verifier);

    let events = ctx.env.events().all();
    let verifier_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("zkme_upd")
        }
    });
    let (_, topics, data) = verifier_event.expect("zkme verifier event must be emitted");

    let topic_caller: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    assert_eq!(
        topic_caller, ctx.admin,
        "zkme verifier event: caller topic must match the authorized caller"
    );

    let (event_old, event_new): (soroban_sdk::Address, soroban_sdk::Address) =
        data.into_val(&ctx.env);
    assert_eq!(
        event_old, old_verifier,
        "zkme verifier event: old verifier must match"
    );
    assert_eq!(
        event_new, new_verifier,
        "zkme verifier event: new verifier must match"
    );
}

#[test]
fn test_set_cooperator_emits_event_with_old_and_new_addresses() {
    let ctx = setup_with_kyc_bypass();
    let old_cooperator = ctx.vault().cooperator();
    let new_cooperator = soroban_sdk::Address::generate(&ctx.env);

    ctx.vault().set_cooperator(&ctx.admin, &new_cooperator);

    let events = ctx.env.events().all();
    let cooperator_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("coop_upd")
        }
    });
    let (_, _, data) = cooperator_event.expect("cooperator event must be emitted");

    let (event_old, event_new): (soroban_sdk::Address, soroban_sdk::Address) =
        data.into_val(&ctx.env);
    assert_eq!(
        event_old, old_cooperator,
        "cooperator event: old cooperator must match"
    );
    assert_eq!(
        event_new, new_cooperator,
        "cooperator event: new cooperator must match"
    );
}

#[test]
fn test_set_funding_target_emits_event_with_caller_and_timestamp() {
    let ctx = setup_with_kyc_bypass();
    let target = 42_000_000i128;

    ctx.vault().set_funding_target(&ctx.admin, &target);

    let events = ctx.env.events().all();
    let funding_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("fund_set")
        }
    });
    let (_, topics, data) = funding_event.expect("funding target event must be emitted");

    let topic_caller: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    assert_eq!(topic_caller, ctx.admin);

    let (event_target, _reason, event_ts): (i128, soroban_sdk::String, u64) =
        data.into_val(&ctx.env);
    assert_eq!(event_target, target);
    assert_eq!(event_ts, ctx.env.ledger().timestamp());
}

#[test]
fn test_set_maturity_date_emits_caller_and_timestamp() {
    let ctx = setup_with_kyc_bypass();
    let new_maturity = 2_100_000_000u64;

    ctx.vault().set_maturity_date(&ctx.operator, &new_maturity);

    let events = ctx.env.events().all();
    let maturity_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("mat_set")
        }
    });
    let (_, topics, data) = maturity_event.expect("maturity event must be emitted");

    let topic_caller: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    assert_eq!(topic_caller, ctx.operator);

    let (_old, event_new, _state, event_ts): (u64, u64, crate::types::VaultState, u64) =
        data.into_val(&ctx.env);
    assert_eq!(event_new, new_maturity);
    assert_eq!(event_ts, ctx.env.ledger().timestamp());
}

#[test]
fn test_set_operator_true_emits_operator_added_event() {
    let ctx = setup_with_kyc_bypass();
    let new_operator = soroban_sdk::Address::generate(&ctx.env);

    ctx.vault().set_operator(&ctx.admin, &new_operator, &true);

    let events = ctx.env.events().all();
    let op_add_event = events.iter().find(|(contract, topics, _)| {
        *contract == ctx.vault_id && {
            let sym: soroban_sdk::Symbol = topics.get_unchecked(0).into_val(&ctx.env);
            sym == symbol_short!("op_add")
        }
    });
    let (_, topics, data) = op_add_event.expect("operator-added event must be emitted");

    let topic_caller: soroban_sdk::Address = topics.get_unchecked(1).into_val(&ctx.env);
    let topic_operator: soroban_sdk::Address = topics.get_unchecked(2).into_val(&ctx.env);
    assert_eq!(topic_caller, ctx.admin);
    assert_eq!(topic_operator, new_operator);

    let event_ts: u64 = data.into_val(&ctx.env);
    assert_eq!(event_ts, ctx.env.ledger().timestamp());
}
