//! Shared test harness for single_rwa_vault tests.

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock USDC token
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct MockUsdc;

#[contractimpl]
impl MockUsdc {
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&id).unwrap_or(0i128)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_bal: i128 = e.storage().persistent().get(&from).unwrap_or(0);
        if from_bal < amount {
            panic!("insufficient token balance");
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

mod _bypass {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[contract]
    pub struct AlwaysApproveZkme;

    #[contractimpl]
    impl AlwaysApproveZkme {
        pub fn has_approved(_e: Env, _cooperator: Address, _user: Address) -> bool {
            true
        }
    }
}
pub use _bypass::AlwaysApproveZkme;

// ─────────────────────────────────────────────────────────────────────────────

pub struct TestContext {
    pub env: Env,
    pub vault_id: Address,
    pub asset_id: Address,
    pub kyc_id: Address,
    pub admin: Address,
    pub operator: Address,
    pub user: Address,
    pub cooperator: Address,
    pub params: InitParams,
}

impl TestContext {
    pub fn vault(&self) -> SingleRWAVaultClient<'_> {
        SingleRWAVaultClient::new(&self.env, &self.vault_id)
    }

    pub fn asset(&self) -> MockUsdcClient<'_> {
        MockUsdcClient::new(&self.env, &self.asset_id)
    }
}

// ─────────────────────────────────────────────────────────────────────────────

pub fn setup() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let user = Address::generate(&env);
    let cooperator = Address::generate(&env);

    let asset_id = env.register(MockUsdc, ());
    let kyc_id = env.register(MockZkme, ());

    let params = default_params(
        &env,
        asset_id.clone(),
        admin.clone(),
        kyc_id.clone(),
        cooperator.clone(),
    );

    let vault_id = env.register(SingleRWAVault, (params.clone(),));

    SingleRWAVaultClient::new(&env, &vault_id)
        .set_operator(&admin, &operator, &true);

    TestContext {
        env,
        vault_id,
        asset_id,
        kyc_id,
        admin,
        operator,
        user,
        cooperator,
        params,
    }
}

pub fn setup_with_kyc_bypass() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let user = Address::generate(&env);
    let cooperator = Address::generate(&env);

    let asset_id = env.register(MockUsdc, ());
    let kyc_id = env.register(AlwaysApproveZkme, ());

    let params = default_params(
        &env,
        asset_id.clone(),
        admin.clone(),
        kyc_id.clone(),
        cooperator.clone(),
    );

    let vault_id = env.register(SingleRWAVault, (params.clone(),));

    SingleRWAVaultClient::new(&env, &vault_id)
        .set_operator(&admin, &operator, &true);

    TestContext {
        env,
        vault_id,
        asset_id,
        kyc_id,
        admin,
        operator,
        user,
        cooperator,
        params,
    }
}

// ─────────────────────────────────────────────────────────────────────────────

pub fn mint_usdc(env: &Env, asset_id: &Address, recipient: &Address, amount: i128) {
    MockUsdcClient::new(env, asset_id).mint(recipient, &amount);
}

pub fn advance_time(env: &Env, seconds: u64) {
    let now = env.ledger().timestamp();
    env.ledger().with_mut(|li| li.timestamp = now + seconds);
}

// ─────────────────────────────────────────────────────────────────────────────

fn default_params(
    env: &Env,
    asset: Address,
    admin: Address,
    zkme_verifier: Address,
    cooperator: Address,
) -> InitParams {
    InitParams {
        asset,
        share_name: String::from_str(env, "StellarYield Bond Share"),
        share_symbol: String::from_str(env, "syBOND"),
        share_decimals: 6u32,
        admin,
        zkme_verifier,
        cooperator,
        funding_target: 100_000_000i128,
        maturity_date: 9_999_999_999u64,
        funding_deadline: 9_999_999_999u64,
        min_deposit: 1_000_000i128,
        max_deposit_per_user: 0i128,
        early_redemption_fee_bps: 200u32,
        rwa_name: String::from_str(env, "US Treasury Bond 2026"),
        rwa_symbol: String::from_str(env, "USTB26"),
        rwa_document_uri: String::from_str(env, "https://example.com/ustb26"),
        rwa_category: String::from_str(env, "Government Bond"),
        expected_apy: 500u32,
        timelock_delay: 172800u64,
        yield_vesting_period: 0u64,
    }
}