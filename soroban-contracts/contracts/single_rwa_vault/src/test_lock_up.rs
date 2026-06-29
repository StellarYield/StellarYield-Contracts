//! Tests for share transfer lock-up period (issue #103).

#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::{Ledger as _, Address as _}, IntoVal};

    use crate::errors::Error;
    use crate::test_helpers::{advance_time, mint_usdc, setup_with_kyc_bypass};

    /// Deposit and immediately try to transfer — should fail if lock-up > 0.
    #[test]
    fn transfer_blocked_during_lockup() {
        let ctx = setup_with_kyc_bypass();
        let vault = ctx.vault();
        ctx.env.ledger().with_mut(|l| l.timestamp = 10_000);
 
        // Configure a 3600-second (1 hour) lock-up via admin.
        vault.set_lock_up_period(&ctx.admin, &3600u64);
 
        let user2 = soroban_sdk::Address::generate(&ctx.env);
 
        mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
        vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);
 
        // Activate vault so transfers are permitted by state guard.
        vault.activate_vault(&ctx.operator);
 
        // Transfer immediately — should panic with SharesLocked.
        let result = ctx
            .env
            .try_invoke_contract::<(), Error>(&ctx.vault_id, &soroban_sdk::symbol_short!("transfer"), (
                ctx.user.clone(),
                user2.clone(),
                1_000_000i128,
            ).into_val(&ctx.env));
        // Expect an error (SharesLocked)
        assert!(result.is_err(), "transfer should fail during lock-up");
    }

    /// After lock-up elapses the transfer should succeed.
    #[test]
    fn transfer_allowed_after_lockup() {
        let ctx = setup_with_kyc_bypass();
        let vault = ctx.vault();
        ctx.env.ledger().with_mut(|l| l.timestamp = 10_000);
        vault.set_lock_up_period(&ctx.admin, &3600u64);
 
        let user2 = soroban_sdk::Address::generate(&ctx.env);
 
        mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
        vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);
 
        vault.activate_vault(&ctx.operator);
 
        // Advance time past the lock-up.
        advance_time(&ctx.env, 3601);
 
        // Transfer should now succeed.
        vault.transfer(&ctx.user, &user2, &1_000_000i128);
        assert_eq!(vault.balance(&user2), 1_000_000i128);
    }

    /// lock_up_remaining returns correct remaining time.
    #[test]
    fn lock_up_remaining_decreases() {
        let ctx = setup_with_kyc_bypass();
        let vault = ctx.vault();
        ctx.env.ledger().with_mut(|l| l.timestamp = 10_000);
        vault.set_lock_up_period(&ctx.admin, &3600u64);
 
        mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
        vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);
 
        // Right after deposit, remaining should be close to 3600.
        let remaining = vault.lock_up_remaining(&ctx.user);
        assert!(remaining > 0 && remaining <= 3600, "remaining={remaining}");
 
        // Advance 1800 seconds.
        advance_time(&ctx.env, 1800);
        let remaining2 = vault.lock_up_remaining(&ctx.user);
        assert!(remaining2 <= 1800, "remaining2={remaining2}");
 
        // Advance past full lock-up.
        advance_time(&ctx.env, 1801);
        assert_eq!(vault.lock_up_remaining(&ctx.user), 0);
    }

    /// redeem_at_maturity bypasses the lock-up.
    #[test]
    fn redeem_at_maturity_bypasses_lockup() {
        let ctx = setup_with_kyc_bypass();
        let vault = ctx.vault();
        vault.set_lock_up_period(&ctx.admin, &999_999u64);

        // Deposit in Funding, activate, then set mature state.
        mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
        vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);
        vault.activate_vault(&ctx.operator);

        // Jump to past maturity date.
        ctx.env.ledger().with_mut(|l| l.timestamp = 9_999_999_999u64 + 1);
        vault.mature_vault(&ctx.operator);

        // redeem_at_maturity should succeed even with active lock-up.
        let shares = vault.balance(&ctx.user);
        vault.redeem_at_maturity(&ctx.user, &shares, &ctx.user, &ctx.user);
    }

    /// Zero lock-up period means transfers are always allowed.
    #[test]
    fn zero_lockup_allows_immediate_transfer() {
        let ctx = setup_with_kyc_bypass();
        let vault = ctx.vault();
        ctx.env.ledger().with_mut(|l| l.timestamp = 10_000);
        // lock_up_period defaults to 0.
 
        let user2 = soroban_sdk::Address::generate(&ctx.env);
 
        mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 100_000_000);
        vault.deposit(&ctx.user, &100_000_000i128, &ctx.user);
 
        vault.activate_vault(&ctx.operator);
 
        vault.transfer(&ctx.user, &user2, &1_000_000i128);
        assert_eq!(vault.balance(&user2), 1_000_000i128);
    }
}
