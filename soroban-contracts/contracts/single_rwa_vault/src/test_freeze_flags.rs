//! Tests for FreezeFlags mechanism.

use crate::tests::make_vault;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // Error::VaultPaused
fn test_freeze_deposit_blocks_deposit() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = crate::SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    crate::tests::MockZkmeClient::new(&e, &zkme_id).approve_user(&user);
    crate::tests::MockTokenClient::new(&e, &token_id).mint(&user, &1000);

    // Freeze deposits
    vault.set_freeze_flags(&admin, &crate::SingleRWAVault::FREEZE_DEPOSIT_MINT);

    vault.deposit(&user, &1000, &user);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // Error::VaultPaused
fn test_freeze_withdraw_blocks_withdraw() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = crate::SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    // Setup: deposit then activate
    crate::tests::MockZkmeClient::new(&e, &zkme_id).approve_user(&user);
    crate::tests::MockTokenClient::new(&e, &token_id).mint(&user, &5000);
    vault.deposit(&user, &5000, &user);
    vault.activate_vault(&admin);

    // Freeze withdraw/redeem
    vault.set_freeze_flags(&admin, &crate::SingleRWAVault::FREEZE_WITHDRAW_REDEEM);

    vault.withdraw(&user, &1000, &user, &user);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // Error::VaultPaused
fn test_freeze_yield_blocks_claim_yield() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = crate::SingleRWAVaultClient::new(&e, &vault_id);
    let token = crate::tests::MockTokenClient::new(&e, &token_id);
    let user = Address::generate(&e);

    // Setup: deposit then activate then distribute yield
    crate::tests::MockZkmeClient::new(&e, &zkme_id).approve_user(&user);
    token.mint(&user, &10_000);
    vault.deposit(&user, &10_000, &user);
    vault.activate_vault(&admin);

    // Admin is operator by default in make_vault. Mint yield tokens and distribute.
    token.mint(&admin, &2_000);
    vault.distribute_yield(&admin, &2_000);

    // Freeze yield operations
    vault.set_freeze_flags(&admin, &crate::SingleRWAVault::FREEZE_YIELD);

    vault.claim_yield(&user);
}

#[test]
fn test_pause_sets_freeze_all_and_unpause_clears() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&e);
    let vault = crate::SingleRWAVaultClient::new(&e, &vault_id);

    let reason = String::from_str(&e, "maintenance");
    vault.pause(&admin, &reason);

    assert!(vault.paused());
    assert_eq!(vault.freeze_flags(), crate::SingleRWAVault::FREEZE_ALL);

    vault.unpause(&admin);
    assert!(!vault.paused());
    assert_eq!(vault.freeze_flags(), 0u32);
}
