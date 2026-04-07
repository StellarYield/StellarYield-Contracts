//! Documents the vault's current accounting behavior with a fee-on-transfer asset.
//!
//! This is intentionally a test-only scenario: deposits and yield are accounted
//! at the requested gross amount, while the mock asset delivers a lower net
//! token balance to the vault after charging a transfer fee.

use crate::test_helpers::{
    normalize_amount, setup_with_fee_on_transfer_asset, FeeOnTransferMockClient,
};
use crate::VaultState;

#[test]
fn test_fee_on_transfer_asset_uses_gross_amounts_for_deposit_and_yield_accounting() {
    let fee_bps = 500u32;
    let ctx = setup_with_fee_on_transfer_asset(fee_bps);
    let vault = ctx.vault();
    let asset = FeeOnTransferMockClient::new(&ctx.env, &ctx.asset_id);

    let deposit_amount = normalize_amount(100.0, 6);
    let deposit_fee = deposit_amount * i128::from(fee_bps) / 10_000i128;
    let net_deposit_received = deposit_amount - deposit_fee;

    asset.mint(&ctx.user, &deposit_amount);
    let shares = vault.deposit(&ctx.user, &deposit_amount, &ctx.user);

    assert_eq!(
        shares, deposit_amount,
        "shares are minted from the gross deposit"
    );
    assert_eq!(
        vault.total_assets(),
        deposit_amount,
        "gross deposit is added to accounting"
    );
    assert_eq!(vault.total_supply(), deposit_amount);
    assert_eq!(vault.user_deposited(&ctx.user), deposit_amount);
    assert_eq!(
        asset.balance(&ctx.vault_id),
        net_deposit_received,
        "vault receives the net asset amount after the transfer fee"
    );
    assert!(
        vault.is_funding_target_met(),
        "gross accounting is used for funding target checks"
    );

    vault.activate_vault(&ctx.admin);
    assert_eq!(vault.vault_state(), VaultState::Active);

    let yield_amount = normalize_amount(10.0, 6);
    let yield_fee = yield_amount * i128::from(fee_bps) / 10_000i128;
    let net_yield_received = yield_amount - yield_fee;

    asset.mint(&ctx.admin, &yield_amount);
    let epoch = vault.distribute_yield(&ctx.admin, &yield_amount);

    assert_eq!(epoch, 1u32);
    assert_eq!(vault.epoch_yield(&epoch), yield_amount);
    assert_eq!(vault.total_yield_distributed(), yield_amount);
    assert_eq!(vault.pending_yield(&ctx.user), yield_amount);
    assert_eq!(
        vault.total_assets(),
        deposit_amount + yield_amount,
        "yield accounting also uses the gross amount requested by the operator"
    );
    assert_eq!(
        asset.balance(&ctx.vault_id),
        net_deposit_received + net_yield_received,
        "actual vault token balance only reflects net transfers"
    );

    let claimed = vault.claim_yield(&ctx.user);

    assert_eq!(
        claimed, yield_amount,
        "claim accounting uses the full gross epoch yield"
    );
    assert_eq!(vault.total_yield_claimed(&ctx.user), yield_amount);
    assert_eq!(vault.pending_yield(&ctx.user), 0);
    assert_eq!(
        asset.balance(&ctx.user),
        net_yield_received,
        "the outbound claim transfer is also haircut by the asset fee"
    );
    assert_eq!(
        asset.balance(&ctx.vault_id),
        net_deposit_received + net_yield_received - yield_amount,
        "claiming the gross yield consumes more vault balance than the net yield transfer supplied"
    );
    assert!(
        asset.balance(&ctx.vault_id) < vault.total_assets(),
        "the test documents the current mismatch between recorded assets and actual token balance"
    );
}
