extern crate std;
use crate::test_helpers::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[test]
fn test_multiple_deposit_times() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;

    // User A and B
    let user_a = Address::generate(env);
    let user_b = Address::generate(env);

    // Set funding target to 1M to match the test deposit
    ctx.vault().set_funding_target(&ctx.admin, &1_000_000i128);

    // User A deposits early (1:1 price)
    mint_usdc(env, &ctx.asset_id, &user_a, 1_000_000);
    ctx.vault().deposit(&user_a, &1_000_000i128, &user_a);

    // Verify A shares
    assert_eq!(ctx.vault().balance(&user_a), 1_000_000);

    // Activate and distribute yield (100% yield)
    ctx.vault().activate_vault(&ctx.operator);
    mint_usdc(env, &ctx.asset_id, &ctx.operator, 1_000_000);
    ctx.vault().distribute_yield(&ctx.operator, &1_000_000i128);

    // Current state: 2M assets, 1M shares -> Price = 2.0

    // User B deposits later
    mint_usdc(env, &ctx.asset_id, &user_b, 1_000_000);
    ctx.vault().deposit(&user_b, &1_000_000i128, &user_b);

    // With virtual offset: shares = 1M * (1M + 1M) / (2M + 1M) = 666,666
    // B should get 666,666 shares (virtual offset changes the ratio)
    assert_eq!(ctx.vault().balance(&user_b), 666_666);

    // Distribute more yield (1.5M assets)
    mint_usdc(env, &ctx.asset_id, &ctx.operator, 1_500_000);
    ctx.vault().distribute_yield(&ctx.operator, &1_500_000i128);

    // Total shares = 1M (A) + 666,666 (B) = 1,666,666
    // Epoch 2 yield = 1.5M distributed among 1,666,666 shares

    // Pending yield for A:
    // - Epoch 1: 1M * 1M / 1M = 1M
    // - Epoch 2: 1M * 1.5M / 1,666,666 = 900,000 (floor)
    // Total: 1,900,000
    assert_eq!(ctx.vault().pending_yield(&user_a), 1_900_000);

    // Pending yield for B:
    // - Epoch 2: 666,666 * 1.5M / 1,666,666 = 599,999 (floor)
    assert_eq!(ctx.vault().pending_yield(&user_b), 599_999);

    // Verify shares remain correct
    assert_eq!(ctx.vault().balance(&user_a), 1_000_000);
    assert_eq!(ctx.vault().balance(&user_b), 666_666);
}
