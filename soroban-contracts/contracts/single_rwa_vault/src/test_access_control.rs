extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _},
    Address, Env, IntoVal, String,
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
            funding_target: 10_000_000i128,
            maturity_date: 9_999_999_999u64,
            funding_deadline: 0u64,
            min_deposit: 0i128,
            max_deposit_per_user: 0i128,
            early_redemption_fee_bps: 200u32,
            operator_fee_bps: 0u32,
            rwa_name: String::from_str(env, "Bond A"),
            rwa_symbol: String::from_str(env, "BOND"),
            rwa_document_uri: String::from_str(env, "https://example.com"),
            rwa_category: String::from_str(env, "Bond"),
            expected_apy: 500u32,
            timelock_delay: 172800u64, // 48 hours
            yield_vesting_period: 0u64,
        },),
    );

    (vault_id, token_id, zkme_id, admin)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Role Management
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_operator_grants_access() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let operator = Address::generate(&e);

    // With mock_all_auths, every address passes auth checks
    // So we can't test non-operator status properly
    // Just test that we can set an operator
    vault.set_operator(&admin, &operator, &true);
    assert!(vault.is_operator(&operator));
}

#[test]
fn test_set_operator_revokes_access() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let operator = Address::generate(&e);

    vault.set_operator(&admin, &operator, &true);
    assert!(vault.is_operator(&operator));
    vault.set_operator(&admin, &operator, &false);
    assert!(!vault.is_operator(&operator));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_set_operator_non_admin_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, _) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let non_admin = Address::generate(&e);
    let operator = Address::generate(&e);

    vault.set_operator(&non_admin, &operator, &true);
}

#[test]
#[should_panic(expected = "Error(Contract, #38)")]
fn test_transfer_admin() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, old_admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let new_admin = Address::generate(&e);

    // Initial check
    assert_eq!(vault.admin(), old_admin);

    // Transfer admin now requires timelock - should fail
    vault.transfer_admin(&old_admin, &new_admin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Pause / Unpause
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // Error::VaultPaused = 11
fn test_pause_blocks_deposits() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    // Grant operator to admin so they can pause
    vault.set_operator(&admin, &admin, &true);
    vault.pause(&admin, &String::from_str(&e, "Maintenance"));
    assert!(vault.paused());

    // Try to deposit
    MockTokenClient::new(&e, &token_id).mint(&user, &1000);
    vault.deposit(&user, &1000, &user);
}

#[test]
fn test_unpause_resumes_operations() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    vault.set_operator(&admin, &admin, &true);
    vault.pause(&admin, &String::from_str(&e, "Maintenance"));
    assert!(vault.paused());

    vault.unpause(&admin);
    assert!(!vault.paused());

    // Deposit should work now
    MockZkmeClient::new(&e, &zkme_id).approve_user(&user);
    MockTokenClient::new(&e, &token_id).mint(&user, &1000);
    vault.deposit(&user, &1000, &user);
    assert_eq!(vault.balance(&user), 1000);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotKYCVerified
fn test_deposit_without_kyc_fails() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _zkme_id, _admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let user = Address::generate(&e);

    MockTokenClient::new(&e, &token_id).mint(&user, &1_000_000i128);

    // User is intentionally not approved in MockZkme.
    vault.deposit(&user, &1_000_000i128, &user);
}

#[test]
fn test_pause_emits_event_with_reason() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    vault.set_operator(&admin, &admin, &true);
    let reason = String::from_str(&e, "Critical failure");
    vault.pause(&admin, &reason);

    let last_event = e.events().all().last().unwrap();
    // emit_emergency_action(e, true, reason): (symbol!("emergency"),), (true, reason)
    let (_, topics, data) = last_event;
    let topic: soroban_sdk::Symbol = topics.get(0).unwrap().into_val(&e);
    assert_eq!(topic, soroban_sdk::symbol_short!("emergency"));

    let (paused, event_reason): (bool, String) = data.into_val(&e);
    assert!(paused);
    assert_eq!(event_reason, reason);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — Emergency
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_emergency_withdraw_drains_vault() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let recipient = Address::generate(&e);

    // Add some funds to the vault
    token.mint(&vault_id, &5000);
    assert_eq!(token.balance(&vault_id), 5000);

    // Pause vault first to bypass timelock check
    vault.pause(&admin, &String::from_str(&e, "Test"));

    vault.emergency_withdraw(&admin, &recipient);

    // Vault should be empty
    assert_eq!(token.balance(&vault_id), 0);
    // Recipient should have funds
    assert_eq!(token.balance(&recipient), 5000);
    // Vault should be paused
    assert!(vault.paused());
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_emergency_withdraw_non_admin_panics() {
    let e = Env::default();
    let (vault_id, _, _, _) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    // An address with no role — not TreasuryManager, FullOperator, or admin.
    let nobody = Address::generate(&e);
    let recipient = Address::generate(&e);

    // No auth mocking - should fail at auth level
    vault.emergency_withdraw(&nobody, &recipient);
}

#[test]
fn test_emergency_withdraw_zero_balance_no_transfer() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let recipient = Address::generate(&e);

    assert_eq!(token.balance(&vault_id), 0);

    // Pause vault first to bypass timelock check
    vault.pause(&admin, &String::from_str(&e, "Test"));

    vault.emergency_withdraw(&admin, &recipient);

    assert_eq!(token.balance(&recipient), 0);
    assert!(vault.paused());
}

#[test]
fn test_emergency_withdraw_treasury_manager_authorized() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, _zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let tm = Address::generate(&e);
    let recipient = Address::generate(&e);

    // Grant TreasuryManager role
    vault.grant_role(&admin, &tm, &Role::TreasuryManager);

    token.mint(&vault_id, &1000);
    vault.emergency_withdraw(&tm, &recipient);

    assert_eq!(token.balance(&recipient), 1000);
    assert!(vault.paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // Error::NotOperator = 3
fn test_emergency_withdraw_unauthorized_role_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let lm = Address::generate(&e);
    let recipient = Address::generate(&e);

    // Grant LifecycleManager role — this is authorized for some things, but NOT emergency withdraw
    vault.grant_role(&admin, &lm, &Role::LifecycleManager);

    vault.emergency_withdraw(&lm, &recipient);
}

#[test]
fn test_full_operator_can_clear_blacklist_under_current_design() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _token_id, _zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let operator = Address::generate(&e);
    let user = Address::generate(&e);

    vault.set_blacklisted(&admin, &user, &true);
    assert!(vault.is_blacklisted(&user));

    // Backward-compatible operator assignment grants the FullOperator superrole,
    // which currently satisfies ComplianceOfficer checks as well.
    vault.set_operator(&admin, &operator, &true);
    vault.set_blacklisted(&operator, &user, &false);

    assert!(!vault.is_blacklisted(&user));
}

#[test]
fn test_unblacklisted_user_can_resume_deposit_and_withdraw() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let zkme = MockZkmeClient::new(&e, &zkme_id);
    let operator = Address::generate(&e);
    let user = Address::generate(&e);

    let initial_deposit = 1_000_000i128;
    let resumed_deposit = 250_000i128;
    let resumed_withdraw = 200_000i128;

    vault.set_operator(&admin, &operator, &true);
    zkme.approve_user(&user);
    token.mint(&user, &2_000_000);

    vault.deposit(&user, &initial_deposit, &user);
    assert_eq!(vault.balance(&user), initial_deposit);

    // Move to Active so both deposit and withdraw are valid once the issue is resolved.
    vault.set_funding_target(&admin, &initial_deposit);
    vault.activate_vault(&admin);

    vault.set_blacklisted(&admin, &user, &true);
    assert!(vault.is_blacklisted(&user));

    let blocked_deposit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.deposit(&user, &resumed_deposit, &user);
    }));
    assert!(
        blocked_deposit.is_err(),
        "blacklisted user deposit must fail"
    );

    let blocked_withdraw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.withdraw(&user, &resumed_withdraw, &user, &user);
    }));
    assert!(
        blocked_withdraw.is_err(),
        "blacklisted user withdraw must fail"
    );

    // Current design allows a FullOperator to clear blacklist status.
    vault.set_blacklisted(&operator, &user, &false);
    assert!(!vault.is_blacklisted(&user));

    vault.deposit(&user, &resumed_deposit, &user);
    assert_eq!(vault.balance(&user), initial_deposit + resumed_deposit);

    vault.withdraw(&user, &resumed_withdraw, &user, &user);
    assert_eq!(
        vault.balance(&user),
        initial_deposit + resumed_deposit - resumed_withdraw
    );
    assert_eq!(
        token.balance(&user),
        2_000_000 - initial_deposit - resumed_deposit + resumed_withdraw
    );
}

#[test]
fn test_multiple_consecutive_pauses_and_unpauses() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let zkme = MockZkmeClient::new(&e, &zkme_id);
    let user = Address::generate(&e);

    // Grant operator to admin
    vault.set_operator(&admin, &admin, &true);

    // Approve user for KYC
    zkme.approve_user(&user);
    token.mint(&user, &15_000_000);

    // Initial state: not paused, deposit should work
    assert!(!vault.paused());
    vault.deposit(&user, &100_000, &user);
    assert_eq!(vault.balance(&user), 100_000);

    // Pause #1
    vault.pause(&admin, &String::from_str(&e, "Pause 1"));
    assert!(vault.paused());

    // Unpause #1
    vault.unpause(&admin);
    assert!(!vault.paused());
    vault.deposit(&user, &100_000, &user);
    assert_eq!(vault.balance(&user), 200_000);

    // Pause #2
    vault.pause(&admin, &String::from_str(&e, "Pause 2"));
    assert!(vault.paused());

    // Unpause #2
    vault.unpause(&admin);
    assert!(!vault.paused());
    vault.deposit(&user, &100_000, &user);
    assert_eq!(vault.balance(&user), 300_000);

    // Pause #3
    vault.pause(&admin, &String::from_str(&e, "Pause 3"));
    assert!(vault.paused());

    // Unpause #3
    vault.unpause(&admin);
    assert!(!vault.paused());
    vault.deposit(&user, &100_000, &user);
    assert_eq!(vault.balance(&user), 400_000);

    // Pause #4
    vault.pause(&admin, &String::from_str(&e, "Pause 4"));
    assert!(vault.paused());

    // Unpause #4
    vault.unpause(&admin);
    assert!(!vault.paused());

    // Final verification: operations still work correctly after multiple pause/unpause cycles
    vault.deposit(&user, &100_000, &user);
    assert_eq!(vault.balance(&user), 500_000);

    // Verify state is consistent - vault is still in Funding state
    assert!(!vault.paused());
    assert_eq!(vault.balance(&user), 500_000);
    assert_eq!(token.balance(&user), 14_500_000); // 15_000_000 - 500_000
}

#[test]
fn test_share_transfer_succeeds_while_vault_paused() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, token_id, zkme_id, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);
    let token = MockTokenClient::new(&e, &token_id);
    let zkme = MockZkmeClient::new(&e, &zkme_id);
    let from_user = Address::generate(&e);
    let to_user = Address::generate(&e);

    vault.set_operator(&admin, &admin, &true);
    zkme.approve_user(&from_user);
    zkme.approve_user(&to_user);

    token.mint(&from_user, &1_000_000);
    vault.deposit(&from_user, &500_000, &from_user);
    assert_eq!(vault.balance(&from_user), 500_000);
    assert_eq!(vault.balance(&to_user), 0);

    vault.pause(&admin, &String::from_str(&e, "Paused for transfer test"));
    assert!(vault.paused());

    let xfer = 200_000i128;
    vault.transfer(&from_user, &to_user, &xfer);

    assert_eq!(vault.balance(&from_user), 300_000);
    assert_eq!(vault.balance(&to_user), xfer);
    assert!(vault.paused());
}

/// While paused, `pause` freezes deposit / withdraw / redeem / yield entrypoints
/// but does not consult those guards on `transfer` / `transfer_from` (#207).
#[test]
fn test_pause_does_not_add_share_transfer_state_guard_in_contract() {
    let src = include_str!("lib.rs");
    assert!(
        src.contains("pub fn transfer(e: &Env, from: Address, to: Address, amount: i128)"),
        "transfer entrypoint must remain present for this invariant test"
    );
    let transfer_fn_start = src
        .find("pub fn transfer(e: &Env, from: Address, to: Address, amount: i128)")
        .unwrap();
    let transfer_fn_tail = &src[transfer_fn_start..transfer_fn_start + 800];
    assert!(
        !transfer_fn_tail.contains("get_paused")
            && !transfer_fn_tail.contains("require_not_frozen"),
        "share transfer must not gate on pause/freeze so holders can still move claims off-wallet"
    );
}

// ─── Test: operator cannot transfer admin ─────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_operator_cannot_transfer_admin() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let operator = Address::generate(&e);
    let new_admin = Address::generate(&e);

    // Grant full operator privileges to `operator`
    vault.set_operator(&admin, &operator, &true);
    assert!(vault.is_operator(&operator));

    // Operator attempts an admin-only action: transfer_admin
    // Must panic with NotAdmin (#4), not the timelock error (#38)
    // that fires when a legitimate admin calls this.
    vault.transfer_admin(&operator, &new_admin);
}

/// Companion positive test: after the attempted escalation fails, the admin
/// address is unchanged and the operator retains only operator privileges.
/// This confirms the failure is clean — no partial state mutation occurs.
#[test]
fn test_operator_escalation_attempt_leaves_state_intact() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let operator = Address::generate(&e);
    let new_admin = Address::generate(&e);

    vault.set_operator(&admin, &operator, &true);
    assert!(vault.is_operator(&operator));

    // Capture the result without panicking
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.transfer_admin(&operator, &new_admin);
    }));

    // Call must have failed
    assert!(result.is_err(), "operator transfer_admin must fail");

    // Admin address must be unchanged
    assert_eq!(
        vault.admin(),
        admin,
        "admin address must not change after failed operator escalation"
    );

    // Operator must still be an operator (not silently revoked)
    assert!(
        vault.is_operator(&operator),
        "operator status must be unchanged after failed escalation"
    );

    // new_admin must not have become admin
    assert_ne!(
        vault.admin(),
        new_admin,
        "new_admin must not have been installed"
    );
}

/// Admin-only actions beyond transfer_admin: `set_operator` itself is also
/// admin-only. An operator must not be able to grant operator status to others.
#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_operator_cannot_grant_operator_to_others() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let operator = Address::generate(&e);
    let new_oper = Address::generate(&e);

    vault.set_operator(&admin, &operator, &true);

    // Operator attempts to grant operator status to another address
    // Must fail with NotAdmin — only admin can manage operator assignments
    vault.set_operator(&operator, &new_oper, &true);
}

/// An operator also must not be able to revoke another operator.
/// Operator management is exclusively an admin capability.
#[test]
#[should_panic(expected = "Error(Contract, #4)")] // Error::NotAdmin = 4
fn test_operator_cannot_revoke_other_operator() {
    let e = Env::default();
    e.mock_all_auths();
    let (vault_id, _, _, admin) = make_vault(&e);
    let vault = SingleRWAVaultClient::new(&e, &vault_id);

    let operator_a = Address::generate(&e);
    let operator_b = Address::generate(&e);

    // Admin grants both operators
    vault.set_operator(&admin, &operator_a, &true);
    vault.set_operator(&admin, &operator_b, &true);

    // operator_a attempts to revoke operator_b — must fail
    vault.set_operator(&operator_a, &operator_b, &false);
}
