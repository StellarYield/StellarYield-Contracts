//! Shared test harness for single_rwa_vault tests.
//!
//! ## Usage
//!
//! ```rust
//! use crate::test_helpers::{setup, setup_with_kyc_bypass, mint_usdc, advance_time};
//!
//! let ctx = setup();                // KYC enforced (real zkMe mock)
//! let ctx = setup_with_kyc_bypass(); // KYC auto-passes
//!
//! mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1_000_000);
//! ctx.vault.deposit(&ctx.user, &1_000_000i128, &ctx.user);
//!
//! advance_time(&ctx.env, 60);      // advance ledger timestamp by 60 seconds
//! ```
//!
//! ## Struct fields
//!
//! | Field         | Type                    | Description                            |
//! |---------------|-------------------------|----------------------------------------|
//! | `env`         | `Env`                   | Soroban test environment               |
//! | `vault_id`    | `Address`               | Deployed vault contract address        |
//! | `vault`       | `SingleRWAVaultClient`  | Convenience client for the vault       |
//! | `asset_id`    | `Address`               | Deployed mock USDC token address       |
//! | `asset`       | `MockUsdcClient`        | Convenience client for the token       |
//! | `admin`       | `Address`               | Admin / initial operator               |
//! | `operator`    | `Address`               | Secondary operator added at setup      |
//! | `user`        | `Address`               | Generic non-privileged user            |
//! | `kyc_id`      | `Address`               | Deployed zkMe verifier mock address    |
//! | `cooperator`  | `Address`               | zkMe cooperator address                |
//! | `params`      | `InitParams`            | The InitParams used to construct vault |

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{InitParams, SingleRWAVault, SingleRWAVaultClient};

// ─────────────────────────────────────────────────────────────────────────────
// Mock USDC token
// A minimal SEP-41 compatible token for testing.  Exposes `mint` for test setup.
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

    /// Test-only mint — no auth required.
    pub fn mint(e: Env, to: Address, amount: i128) {
        let bal: i128 = e.storage().persistent().get(&to).unwrap_or(0);
        e.storage().persistent().set(&to, &(bal + amount));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock zkMe verifier
// Maintains a per-user approval flag settable by test code.
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct MockZkme;

#[contractimpl]
impl MockZkme {
    /// Returns true when `approve_user` has been called for `user`.
    pub fn has_approved(e: Env, _cooperator: Address, user: Address) -> bool {
        e.storage().instance().get(&user).unwrap_or(false)
    }

    /// Grant KYC approval to a user (test helper, no auth required).
    pub fn approve_user(e: Env, user: Address) {
        e.storage().instance().set(&user, &true);
    }
}

// Bypass verifier — always approves everyone.
// Placed in its own sub-module to avoid Soroban macro symbol collisions
// with MockZkme (both expose `has_approved`).
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
// TestContext — returned by setup() and setup_with_kyc_bypass()
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
    /// Construct a vault client that borrows the contained env.
    pub fn vault(&self) -> SingleRWAVaultClient<'_> {
        SingleRWAVaultClient::new(&self.env, &self.vault_id)
    }
    /// Construct a mock-USDC token client that borrows the contained env.
    pub fn asset(&self) -> MockUsdcClient<'_> {
        MockUsdcClient::new(&self.env, &self.asset_id)
    }
}

/// Standard setup with a real controllable zkMe mock.
/// No user has KYC by default — call `MockZkmeClient::new(&ctx.env, &ctx.kyc_id).approve_user(&addr)` to grant it.
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

    // Add a secondary operator.
    SingleRWAVaultClient::new(&env, &vault_id).set_operator(&admin, &operator, &true);

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

/// Setup where KYC always passes — uses AlwaysApproveZkme.
/// Convenient for deposit/transfer tests that don't focus on KYC.
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

    SingleRWAVaultClient::new(&env, &vault_id).set_operator(&admin, &operator, &true);

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Mint `amount` of the mock USDC token to `recipient`.
pub fn mint_usdc(env: &Env, asset_id: &Address, recipient: &Address, amount: i128) {
    MockUsdcClient::new(env, asset_id).mint(recipient, &amount);
}

/// Convert a human-readable amount into on-chain integer units.
///
/// Examples:
/// - `normalize_amount(1.0, 6) == 1_000_000`
/// - `normalize_amount(2.5, 6) == 2_500_000`
pub fn normalize_amount(amount: f64, decimals: u32) -> i128 {
    let scale = 10f64.powi(decimals as i32);
    (amount * scale).round() as i128
}

/// Advance the ledger timestamp by `seconds`.
pub fn advance_time(env: &Env, seconds: u64) {
    let now = env.ledger().timestamp();
    env.ledger().with_mut(|li| li.timestamp = now + seconds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: build the default InitParams
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
        funding_target: 100_000_000i128,    // 100 USDC (6 decimals)
        maturity_date: 9_999_999_999u64,    // far future
        funding_deadline: 9_999_999_999u64, // far future (no effective deadline by default)
        min_deposit: 1_000_000i128,         // 1 USDC
        max_deposit_per_user: 0i128,        // unlimited
        early_redemption_fee_bps: 200u32,   // 2 %
        rwa_name: String::from_str(env, "US Treasury Bond 2026"),
        rwa_symbol: String::from_str(env, "USTB26"),
        rwa_document_uri: String::from_str(env, "https://example.com/ustb26"),
        rwa_category: String::from_str(env, "Government Bond"),
        expected_apy: 500u32,       // 5 %
        timelock_delay: 172800u64,  // 48 hours
        yield_vesting_period: 0u64, // Default to 0 for instant claiming (backward compatibility)
    }
}
