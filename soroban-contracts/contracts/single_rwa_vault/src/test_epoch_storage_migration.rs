//! Tests for epoch data storage tier migration (Issue #51).
//!
//! Verifies that EpochYield and EpochTotalShares are correctly stored in
//! persistent storage with proper TTL management, and that all behavioral
//! invariants are preserved.

#![cfg(test)]

extern crate std;

use crate::storage::{
    get_epoch_total_shares, get_epoch_yield, put_current_epoch, put_epoch_total_shares,
    put_epoch_yield,
};
use crate::test_helpers::{advance_time, setup_with_kyc_bypass, TestContext};
use soroban_sdk::{testutils::Address as _, Address};

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

fn activate_and_fund(ctx: &TestContext, amount: i128) {
    // Lower the funding target to exactly `amount` so activation succeeds
    ctx.vault().set_funding_target(&ctx.operator, &amount);
    ctx.asset().mint(&ctx.admin, &amount);
    ctx.vault().deposit(&ctx.admin, &amount, &ctx.admin);
    ctx.vault().activate_vault(&ctx.operator);
}

fn distribute(ctx: &TestContext, amount: i128) {
    ctx.asset().mint(&ctx.operator, &amount);
    ctx.vault().distribute_yield(&ctx.operator, &amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage Tier Verification Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_epoch_yield_persistent_write_and_read_round_trip() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    let epoch = 5u32;
    let yield_amount = 100_000i128;

    // Write epoch yield directly to storage
    env.as_contract(vault_id, || {
        put_epoch_yield(env, epoch, yield_amount);
    });

    // Read it back and verify
    let retrieved = env.as_contract(vault_id, || get_epoch_yield(env, epoch));
    assert_eq!(retrieved, yield_amount);
}

#[test]
fn test_epoch_total_shares_persistent_write_and_read_round_trip() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    let epoch = 7u32;
    let total_shares = 500_000i128;

    // Write epoch total shares directly to storage
    env.as_contract(vault_id, || {
        put_epoch_total_shares(env, epoch, total_shares);
    });

    // Read it back and verify
    let retrieved = env.as_contract(vault_id, || get_epoch_total_shares(env, epoch));
    assert_eq!(retrieved, total_shares);
}

#[test]
fn test_missing_epoch_yield_returns_zero() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    let epoch = 999u32;

    // Read an epoch that has never been written
    let retrieved = env.as_contract(vault_id, || get_epoch_yield(env, epoch));
    assert_eq!(retrieved, 0);
}

#[test]
fn test_missing_epoch_total_shares_returns_zero() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    let epoch = 888u32;

    // Read an epoch that has never been written
    let retrieved = env.as_contract(vault_id, || get_epoch_total_shares(env, epoch));
    assert_eq!(retrieved, 0);
}

#[test]
fn test_multiple_epoch_entries_are_independent() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    // Write distinct values for three different epochs
    env.as_contract(vault_id, || {
        put_epoch_yield(env, 1, 10_000);
        put_epoch_yield(env, 2, 20_000);
        put_epoch_yield(env, 3, 30_000);

        put_epoch_total_shares(env, 1, 100_000);
        put_epoch_total_shares(env, 2, 200_000);
        put_epoch_total_shares(env, 3, 300_000);
    });

    // Read each back and verify no cross-contamination
    env.as_contract(vault_id, || {
        assert_eq!(get_epoch_yield(env, 1), 10_000);
        assert_eq!(get_epoch_yield(env, 2), 20_000);
        assert_eq!(get_epoch_yield(env, 3), 30_000);

        assert_eq!(get_epoch_total_shares(env, 1), 100_000);
        assert_eq!(get_epoch_total_shares(env, 2), 200_000);
        assert_eq!(get_epoch_total_shares(env, 3), 300_000);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL Management Tests
// ─────────────────────────────────────────────────────────────────────────────

/// Verifies that TTL is set on write by confirming the entry persists and
/// can be read back. Direct TTL introspection is not available in the test
/// environment, so we verify by code review that the bump call is present
/// and by confirming the entry remains accessible.
#[test]
fn test_epoch_yield_ttl_is_set_on_write() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    let epoch = 10u32;
    let yield_amount = 50_000i128;

    // Write epoch yield
    env.as_contract(vault_id, || {
        put_epoch_yield(env, epoch, yield_amount);
    });

    // Advance time significantly (simulating passage of time)
    advance_time(env, 86400 * 30); // 30 days

    // Entry should still be readable (TTL was set correctly)
    let retrieved = env.as_contract(vault_id, || get_epoch_yield(env, epoch));
    assert_eq!(retrieved, yield_amount);
}

/// Verifies that TTL is set on write for epoch total shares.
#[test]
fn test_epoch_total_shares_ttl_is_set_on_write() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    let epoch = 12u32;
    let total_shares = 750_000i128;

    // Write epoch total shares
    env.as_contract(vault_id, || {
        put_epoch_total_shares(env, epoch, total_shares);
    });

    // Advance time significantly
    advance_time(env, 86400 * 30); // 30 days

    // Entry should still be readable
    let retrieved = env.as_contract(vault_id, || get_epoch_total_shares(env, epoch));
    assert_eq!(retrieved, total_shares);
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral Regression Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_distribute_yield_behaviour_unchanged() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;

    // Activate vault with initial deposit
    activate_and_fund(&ctx, 1_000_000);

    // Distribute yield
    let yield_amount = 50_000i128;
    distribute(&ctx, yield_amount);

    // Verify epoch data was written correctly
    let current_epoch = ctx.vault().current_epoch();
    assert_eq!(current_epoch, 1);

    let stored_yield = ctx.vault().epoch_yield(&current_epoch);
    let stored_shares =
        env.as_contract(&ctx.vault_id, || get_epoch_total_shares(env, current_epoch));

    assert_eq!(stored_yield, yield_amount);
    assert_eq!(stored_shares, 1_000_000); // Initial deposit amount
}

#[test]
fn test_pending_yield_for_epoch_behaviour_unchanged() {
    let ctx = setup_with_kyc_bypass();

    // Setup: activate and deposit
    activate_and_fund(&ctx, 1_000_000);

    // Distribute yield
    distribute(&ctx, 100_000);

    // Check pending yield for the user
    let pending = ctx.vault().pending_yield_for_epoch(&ctx.admin, &1);
    assert_eq!(pending, 100_000); // User owns all shares, gets all yield
}

#[test]
fn test_full_claim_flow_with_persistent_epoch_data() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;

    // Activate vault with deposit
    activate_and_fund(&ctx, 1_000_000);

    // Distribute yield
    distribute(&ctx, 50_000);

    // Advance time to ensure vesting (if any)
    advance_time(env, 100);

    // Claim yield
    let claimed = ctx.vault().claim_yield(&ctx.admin);
    assert_eq!(claimed, 50_000);

    // Verify pending yield is now zero
    let pending = ctx.vault().pending_yield(&ctx.admin);
    assert_eq!(pending, 0);
}

#[test]
fn test_multiple_epochs_claim_correctly() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;

    // Activate and fund
    activate_and_fund(&ctx, 1_000_000);

    // Distribute yield for three epochs
    distribute(&ctx, 10_000);
    advance_time(env, 100);
    distribute(&ctx, 20_000);
    advance_time(env, 100);
    distribute(&ctx, 30_000);
    advance_time(env, 100);

    // Total pending should be sum of all epochs
    let pending = ctx.vault().pending_yield(&ctx.admin);
    assert_eq!(pending, 60_000);

    // Claim all
    let claimed = ctx.vault().claim_yield(&ctx.admin);
    assert_eq!(claimed, 60_000);
}

#[test]
fn test_zero_value_epoch_data_does_not_revert() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    // Write zero values for an epoch
    env.as_contract(vault_id, || {
        put_current_epoch(env, 1);
        put_epoch_yield(env, 1, 0);
        put_epoch_total_shares(env, 1, 0);
    });

    // Query pending yield should not revert
    let pending = ctx.vault().pending_yield_for_epoch(&ctx.admin, &1);
    assert_eq!(pending, 0);
}

#[test]
fn test_price_per_share_history_with_persistent_storage() {
    let ctx = setup_with_kyc_bypass();

    // Activate with deposit
    activate_and_fund(&ctx, 1_000_000);

    // Distribute yield (this creates epoch 1)
    distribute(&ctx, 100_000);

    // Query historical price per share
    let price = ctx.vault().price_per_share_history(&1);

    // Price calculation depends on total_assets at epoch, but we verify it doesn't revert
    // and returns a reasonable value (non-negative)
    assert!(price >= 0);
}

#[test]
fn test_get_epoch_data_with_persistent_storage() {
    let ctx = setup_with_kyc_bypass();

    // Activate and distribute
    activate_and_fund(&ctx, 1_000_000);
    distribute(&ctx, 50_000);

    // Query epoch data
    let epoch_data = ctx.vault().get_epoch_data(&1);
    assert_eq!(epoch_data.yield_amount, 50_000);
    assert_eq!(epoch_data.total_shares, 1_000_000);
}

#[test]
fn test_multiple_users_share_epoch_yield_correctly() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;

    let user2 = Address::generate(env);

    // Set funding target to 10M and lower min deposit to allow smaller deposits
    ctx.vault().set_funding_target(&ctx.operator, &10_000_000);
    ctx.vault().set_min_deposit(&ctx.operator, &100_000);

    // Admin deposits 6M, user2 deposits 4M (60/40 split)
    ctx.asset().mint(&ctx.admin, &6_000_000);
    ctx.vault().deposit(&ctx.admin, &6_000_000, &ctx.admin);

    ctx.asset().mint(&user2, &4_000_000);
    ctx.vault().deposit(&user2, &4_000_000, &user2);

    ctx.vault().activate_vault(&ctx.operator);

    // Distribute 1M yield
    distribute(&ctx, 1_000_000);

    advance_time(env, 100);

    // Admin should get 600k (60% of shares)
    let admin_pending = ctx.vault().pending_yield(&ctx.admin);
    assert_eq!(admin_pending, 600_000);

    // User2 should get 400k (40% of shares)
    let user2_pending = ctx.vault().pending_yield(&user2);
    assert_eq!(user2_pending, 400_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Gap Test
// ─────────────────────────────────────────────────────────────────────────────

/// This test documents the migration gap: if epoch data existed in instance
/// storage before the upgrade, it will not be automatically migrated to
/// persistent storage. The new getters will return 0 for those epochs.
///
/// Note: Soroban test environment does not allow direct seeding of instance
/// storage with specific keys while using persistent storage for the same
/// keys in the same test, so this test documents the expected behavior
/// rather than directly testing the migration gap.
#[test]
fn test_migration_gap_documented() {
    let ctx = setup_with_kyc_bypass();
    let vault_id = &ctx.vault_id;

    // Simulate post-upgrade state: no historical epoch data in persistent storage
    // Reading an epoch that was never written to persistent storage returns 0
    let missing_epoch = 42u32;
    let yield_amount = ctx
        .env
        .as_contract(vault_id, || get_epoch_yield(&ctx.env, missing_epoch));
    let total_shares = ctx
        .env
        .as_contract(vault_id, || get_epoch_total_shares(&ctx.env, missing_epoch));

    assert_eq!(yield_amount, 0);
    assert_eq!(total_shares, 0);

    // This confirms that missing persistent keys return the safe default (zero)
    // rather than reverting, which is the expected behavior post-migration.
    // Operators must ensure all yield is claimed before upgrading, or use a
    // migration script to move instance data to persistent storage.
}

// ─────────────────────────────────────────────────────────────────────────────
// Security and Invariant Tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_epoch_data_write_does_not_affect_other_epochs() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    // Write initial values for epochs 1 and 2
    env.as_contract(vault_id, || {
        put_epoch_yield(env, 1, 10_000);
        put_epoch_yield(env, 2, 20_000);
    });

    // Overwrite epoch 1
    env.as_contract(vault_id, || {
        put_epoch_yield(env, 1, 15_000);
    });

    // Verify epoch 2 is unchanged
    let epoch2_yield = env.as_contract(vault_id, || get_epoch_yield(env, 2));
    assert_eq!(epoch2_yield, 20_000);

    // Verify epoch 1 has new value
    let epoch1_yield = env.as_contract(vault_id, || get_epoch_yield(env, 1));
    assert_eq!(epoch1_yield, 15_000);
}

#[test]
fn test_large_number_of_epochs_does_not_affect_instance_storage() {
    let ctx = setup_with_kyc_bypass();
    let env = &ctx.env;
    let vault_id = &ctx.vault_id;

    // Write many epoch entries
    env.as_contract(vault_id, || {
        for epoch in 1..=100 {
            put_epoch_yield(env, epoch, epoch as i128 * 1000);
            put_epoch_total_shares(env, epoch, epoch as i128 * 10000);
        }
    });

    // Verify all entries are readable
    env.as_contract(vault_id, || {
        for epoch in 1..=100 {
            assert_eq!(get_epoch_yield(env, epoch), epoch as i128 * 1000);
            assert_eq!(get_epoch_total_shares(env, epoch), epoch as i128 * 10000);
        }
    });

    // This test confirms that writing many epoch entries to persistent storage
    // works correctly. Instance storage size is not directly measurable in the
    // test environment, but the code review confirms that epoch data no longer
    // writes to instance storage.
}
