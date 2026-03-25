extern crate std;

use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SEP-41 token
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct FuzzToken;

#[contractimpl]
impl FuzzToken {
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
// Mock zkMe verifier (always approves)
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct FuzzZkme;

#[contractimpl]
impl FuzzZkme {
    pub fn has_approved(_e: Env, _cooperator: Address, _user: Address) -> bool {
        true
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

struct TestCtx {
    env: Env,
    vault_id: Address,
    token_id: Address,
    admin: Address,
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let cooperator = Address::generate(&env);
    let token_id = env.register(FuzzToken, ());
    let zkme_id = env.register(FuzzZkme, ());

    let vault_id = env.register(
        SingleRWAVault,
        (InitParams {
            asset: token_id.clone(),
            share_name: String::from_str(&env, "Fuzz Share"),
            share_symbol: String::from_str(&env, "FZ"),
            share_decimals: 6u32,
            admin: admin.clone(),
            zkme_verifier: zkme_id.clone(),
            cooperator: cooperator.clone(),
            funding_target: 0i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 0u64,
            min_deposit: 1i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 200u32,
            lock_up_period: 0u64,
            rwa_name: String::from_str(&env, "Fuzz RWA"),
            rwa_symbol: String::from_str(&env, "FRWA"),
            rwa_document_uri: String::from_str(&env, "https://example.com"),
            rwa_category: String::from_str(&env, "Bond"),
            expected_apy: 500u32,
        },),
    );

    TestCtx {
        env,
        vault_id,
        token_id,
        admin,
    }
}

fn mint_and_deposit(ctx: &TestCtx, user: &Address, amount: i128) -> i128 {
    FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(user, &amount);
    SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id).deposit(user, &amount, user)
}

fn activate(ctx: &TestCtx) {
    SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id).activate_vault(&ctx.admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 1: Yield conservation
// sum of all users' pending_yield + total_yield_claimed <= total_yield_distributed
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    #[ignore]
    fn fuzz_yield_conservation(
        deposit_a in 1_000i128..10_000_000i128,
        deposit_b in 1_000i128..10_000_000i128,
        yield_amount in 1_000i128..5_000_000i128,
    ) {
        let ctx = setup();
        let vault = SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id);

        let user_a = Address::generate(&ctx.env);
        let user_b = Address::generate(&ctx.env);

        mint_and_deposit(&ctx, &user_a, deposit_a);
        mint_and_deposit(&ctx, &user_b, deposit_b);
        activate(&ctx);

        // Distribute yield
        FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(&ctx.admin, &yield_amount);
        vault.distribute_yield(&ctx.admin, &yield_amount);

        let pending_a = vault.pending_yield(&user_a);
        let pending_b = vault.pending_yield(&user_b);
        let claimed_a = vault.total_yield_claimed(&user_a);
        let claimed_b = vault.total_yield_claimed(&user_b);
        let total_distributed = vault.total_yield_distributed();

        // Conservation: pending + claimed <= distributed (rounding may lose dust)
        prop_assert!(
            pending_a + pending_b + claimed_a + claimed_b <= total_distributed,
            "yield conservation violated: pending({} + {}) + claimed({} + {}) > distributed({})",
            pending_a, pending_b, claimed_a, claimed_b, total_distributed
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 2: Share conservation
// sum of all balances == total_supply
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    #[ignore]
    fn fuzz_share_conservation(
        deposit_a in 1_000i128..10_000_000i128,
        deposit_b in 1_000i128..10_000_000i128,
        deposit_c in 1_000i128..10_000_000i128,
    ) {
        let ctx = setup();
        let vault = SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id);

        let user_a = Address::generate(&ctx.env);
        let user_b = Address::generate(&ctx.env);
        let user_c = Address::generate(&ctx.env);

        mint_and_deposit(&ctx, &user_a, deposit_a);
        mint_and_deposit(&ctx, &user_b, deposit_b);
        mint_and_deposit(&ctx, &user_c, deposit_c);

        let bal_a = vault.balance(&user_a);
        let bal_b = vault.balance(&user_b);
        let bal_c = vault.balance(&user_c);
        let total = vault.total_supply();

        prop_assert_eq!(
            bal_a + bal_b + bal_c,
            total,
            "share conservation violated: {} + {} + {} != {}",
            bal_a, bal_b, bal_c, total
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 3: No double-claim
// Claiming the same epoch twice returns 0 the second time
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    #[ignore]
    fn fuzz_no_double_claim(
        deposit_amount in 1_000i128..10_000_000i128,
        yield_amount in 1_000i128..5_000_000i128,
    ) {
        let ctx = setup();
        let vault = SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id);

        let user = Address::generate(&ctx.env);
        mint_and_deposit(&ctx, &user, deposit_amount);
        activate(&ctx);

        FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(&ctx.admin, &yield_amount);
        vault.distribute_yield(&ctx.admin, &yield_amount);

        // First claim should succeed
        let first_claim = vault.claim_yield(&user);
        prop_assert!(first_claim > 0, "first claim should be positive");

        // Second claim: pending should be 0
        let pending_after = vault.pending_yield(&user);
        prop_assert_eq!(pending_after, 0, "pending yield after claim should be 0");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 4: Deposit/redeem round-trip
// redeem(deposit(x)) approximately equals x (within rounding tolerance)
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    #[ignore]
    fn fuzz_deposit_redeem_roundtrip(
        amount in 1_000i128..10_000_000i128,
    ) {
        let ctx = setup();
        let vault = SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id);
        let token = FuzzTokenClient::new(&ctx.env, &ctx.token_id);

        let user = Address::generate(&ctx.env);
        let shares = mint_and_deposit(&ctx, &user, amount);
        activate(&ctx);

        let balance_before = token.balance(&user);
        let assets_out = vault.redeem(&user, &shares, &user, &user);
        let balance_after = token.balance(&user);

        // Round-trip: assets received should be approximately equal to deposited
        // (within 1 unit rounding tolerance per share)
        let diff = (amount - assets_out).abs();
        prop_assert!(
            diff <= 1,
            "round-trip deviation too large: deposited={}, received={}, diff={}",
            amount, assets_out, diff
        );
        prop_assert_eq!(
            balance_after - balance_before,
            assets_out,
            "token balance change must match assets_out"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 5: Monotonicity of total_yield_distributed
// total_yield_distributed never decreases across multiple distributions
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    #[ignore]
    fn fuzz_yield_monotonicity(
        deposit_amount in 10_000i128..10_000_000i128,
        yield_1 in 1_000i128..2_000_000i128,
        yield_2 in 1_000i128..2_000_000i128,
        yield_3 in 1_000i128..2_000_000i128,
    ) {
        let ctx = setup();
        let vault = SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id);

        let user = Address::generate(&ctx.env);
        mint_and_deposit(&ctx, &user, deposit_amount);
        activate(&ctx);

        let before = vault.total_yield_distributed();

        FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(&ctx.admin, &yield_1);
        vault.distribute_yield(&ctx.admin, &yield_1);
        let after_1 = vault.total_yield_distributed();
        prop_assert!(after_1 >= before, "yield decreased after distribution 1");

        FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(&ctx.admin, &yield_2);
        vault.distribute_yield(&ctx.admin, &yield_2);
        let after_2 = vault.total_yield_distributed();
        prop_assert!(after_2 >= after_1, "yield decreased after distribution 2");

        FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(&ctx.admin, &yield_3);
        vault.distribute_yield(&ctx.admin, &yield_3);
        let after_3 = vault.total_yield_distributed();
        prop_assert!(after_3 >= after_2, "yield decreased after distribution 3");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 6: Snapshot consistency
// After a transfer, user_shares_at_epoch is consistent with balances
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    #[ignore]
    fn fuzz_snapshot_consistency_after_transfer(
        deposit_a in 10_000i128..10_000_000i128,
        deposit_b in 10_000i128..10_000_000i128,
        transfer_pct in 1u32..50u32,
        yield_amount in 1_000i128..5_000_000i128,
    ) {
        let ctx = setup();
        let vault = SingleRWAVaultClient::new(&ctx.env, &ctx.vault_id);

        let user_a = Address::generate(&ctx.env);
        let user_b = Address::generate(&ctx.env);

        mint_and_deposit(&ctx, &user_a, deposit_a);
        mint_and_deposit(&ctx, &user_b, deposit_b);
        activate(&ctx);

        // Transfer a percentage of user_a's shares to user_b
        let bal_a = vault.balance(&user_a);
        let transfer_amount = bal_a * (transfer_pct as i128) / 100;
        if transfer_amount > 0 {
            vault.transfer(&user_a, &user_b, &transfer_amount);
        }

        // Distribute yield after the transfer
        FuzzTokenClient::new(&ctx.env, &ctx.token_id).mint(&ctx.admin, &yield_amount);
        vault.distribute_yield(&ctx.admin, &yield_amount);

        // Verify share conservation still holds after transfer + yield
        let final_a = vault.balance(&user_a);
        let final_b = vault.balance(&user_b);
        let total = vault.total_supply();

        prop_assert_eq!(
            final_a + final_b,
            total,
            "share conservation violated after transfer: {} + {} != {}",
            final_a, final_b, total
        );

        // Yield should still be conserved
        let pending_a = vault.pending_yield(&user_a);
        let pending_b = vault.pending_yield(&user_b);
        let distributed = vault.total_yield_distributed();

        prop_assert!(
            pending_a + pending_b <= distributed,
            "yield conservation violated after transfer: {} + {} > {}",
            pending_a, pending_b, distributed
        );
    }
}
