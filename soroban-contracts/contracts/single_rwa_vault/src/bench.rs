//! Resource-cost benchmarks for `SingleRWAVault` (#124).
//!
//! Run with:
//!
//!   `cargo test --package single_rwa_vault --lib bench:: -- --ignored --nocapture`
//!
//! The benchmarks reset the Soroban budget before each call, exercise one
//! contract entry point, and print `cpu_instruction_cost` and
//! `memory_bytes_cost`. The output is intended to be copied into
//! `BENCHMARKS.md` so cost regressions over time are visible in PRs.
//!
//! `bench_deposit_within_cpu_budget` is *not* `#[ignore]` — it runs in
//! every CI invocation as a coarse regression check that the hot deposit
//! path stays well under the Soroban per-transaction CPU budget. The
//! threshold is intentionally generous: native execution underestimates
//! WASM CPU cost (per the SDK docs), so we only catch dramatic regressions.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address,
};
use std::println;

use crate::test_helpers::{mint_usdc, setup_with_kyc_bypass, TestContext};

// Minimum funding to clear the default `funding_target` (100 USDC) so the
// vault can be `activate_vault`'d in benches that need an Active state.
const FUNDING: i128 = 100_000_000;

// Soroban mainnet per-transaction CPU instruction budget.
const SOROBAN_CPU_BUDGET: u64 = 100_000_000;
// Regression alarm bound: 80% of the per-tx budget.
const REGRESSION_BUDGET: u64 = SOROBAN_CPU_BUDGET * 80 / 100;

fn measure<F: FnOnce()>(ctx: &TestContext, label: &str, f: F) -> (u64, u64) {
    // Reset unlimited so the call always completes; we read what it actually
    // consumed afterward. The regression test compares against
    // REGRESSION_BUDGET independently.
    ctx.env.budget().reset_unlimited();
    f();
    let cpu = ctx.env.budget().cpu_instruction_cost();
    let mem = ctx.env.budget().memory_bytes_cost();
    println!("[bench] {label}: cpu={cpu} mem={mem}");
    (cpu, mem)
}

fn fund(ctx: &TestContext, who: &Address, amount: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, who, amount);
    ctx.vault().deposit(who, &amount, who);
}

fn distribute(ctx: &TestContext, amount: i128) {
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, amount);
    ctx.vault().distribute_yield(&ctx.admin, &amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-function CPU/memory snapshots
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[ignore]
fn bench_deposit() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, FUNDING);
    measure(&ctx, "deposit", || {
        ctx.vault().deposit(&user, &FUNDING, &user);
    });
}

#[test]
#[ignore]
fn bench_withdraw() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    fund(&ctx, &user, FUNDING);
    ctx.vault().activate_vault(&ctx.admin);
    measure(&ctx, "withdraw", || {
        ctx.vault().withdraw(&user, &(FUNDING / 2), &user, &user);
    });
}

#[test]
#[ignore]
fn bench_transfer() {
    let ctx = setup_with_kyc_bypass();
    let alice = Address::generate(&ctx.env);
    let bob = Address::generate(&ctx.env);
    // Split funding so the combined deposit does not exceed the funding target.
    fund(&ctx, &alice, FUNDING / 2);
    fund(&ctx, &bob, FUNDING / 2);
    measure(&ctx, "transfer", || {
        ctx.vault().transfer(&alice, &bob, &(FUNDING / 10));
    });
}

#[test]
#[ignore]
fn bench_distribute_yield() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    fund(&ctx, &user, FUNDING);
    ctx.vault().activate_vault(&ctx.admin);
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.admin, FUNDING / 10);
    measure(&ctx, "distribute_yield", || {
        ctx.vault().distribute_yield(&ctx.admin, &(FUNDING / 10));
    });
}

#[test]
#[ignore]
fn bench_claim_yield_1_epoch() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    fund(&ctx, &user, FUNDING);
    ctx.vault().activate_vault(&ctx.admin);
    distribute(&ctx, FUNDING / 10);
    measure(&ctx, "claim_yield/1_epoch", || {
        ctx.vault().claim_yield(&user);
    });
}

#[test]
#[ignore]
fn bench_claim_yield_10_epochs() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    fund(&ctx, &user, FUNDING);
    ctx.vault().activate_vault(&ctx.admin);
    for _ in 0..10 {
        distribute(&ctx, FUNDING / 10);
    }
    measure(&ctx, "claim_yield/10_epochs", || {
        ctx.vault().claim_yield(&user);
    });
}

#[test]
#[ignore]
fn bench_claim_yield_50_epochs() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    fund(&ctx, &user, FUNDING);
    ctx.vault().activate_vault(&ctx.admin);
    for _ in 0..50 {
        distribute(&ctx, FUNDING / 10);
    }
    measure(&ctx, "claim_yield/50_epochs", || {
        ctx.vault().claim_yield(&user);
    });
}

#[test]
#[ignore]
fn bench_redeem_at_maturity() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    fund(&ctx, &user, FUNDING);
    ctx.vault().activate_vault(&ctx.admin);

    // Advance past maturity and mature the vault. (No yield distributions
    // here — redeem_at_maturity also pays out pending yield, so distributing
    // before maturity skews the bench toward the claim_yield code path.)
    let maturity = ctx.vault().maturity_date();
    ctx.env.ledger().with_mut(|li| {
        li.timestamp = maturity + 1;
    });
    ctx.vault().mature_vault(&ctx.admin);

    let shares = ctx.vault().balance(&user);
    measure(&ctx, "redeem_at_maturity", || {
        ctx.vault().redeem_at_maturity(&user, &shares, &user, &user);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// CPU regression alarm (always-on; not #[ignore])
//
// Native execution underestimates WASM cost, so we only flag obvious blow-ups.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn bench_deposit_within_cpu_budget() {
    let ctx = setup_with_kyc_bypass();
    let user = Address::generate(&ctx.env);
    mint_usdc(&ctx.env, &ctx.asset_id, &user, FUNDING);

    let (cpu, _mem) = measure(&ctx, "deposit/regression", || {
        ctx.vault().deposit(&user, &FUNDING, &user);
    });

    assert!(
        cpu < REGRESSION_BUDGET,
        "deposit consumed {cpu} CPU instructions natively, which exceeds 80% of the \
         Soroban per-transaction budget ({REGRESSION_BUDGET}). WASM execution will be \
         strictly more expensive — investigate the regression."
    );
}
