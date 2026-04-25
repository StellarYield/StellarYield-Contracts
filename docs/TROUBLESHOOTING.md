# Troubleshooting Guide

This guide documents common failure scenarios when interacting with StellarYield contracts, along with quick diagnosis checklists and matching error variants.

---

## Common User Scenarios

### Scenario 1: Deposit Transaction Fails

**Symptoms:**
- Transaction reverts when attempting to deposit assets
- Error code returned from `deposit()` call

**Quick Diagnosis Checklist:**

1. **Check KYC Status** (Error: `NotKYCVerified` - Code 1)
   - Verify user has completed zkMe KYC verification
   - Call `is_kyc_verified(user_address)` to check status
   - **Fix:** Complete KYC verification through zkMe before depositing

2. **Check Vault State** (Error: `InvalidVaultState` - Code 5)
   - Verify vault is in `Funding` or `Active` state
   - Call `vault_state()` to check current state
   - **Fix:** Wait for vault to enter appropriate state or choose a different vault

3. **Check Deposit Amount** (Error: `BelowMinimumDeposit` - Code 6 or `ExceedsMaximumDeposit` - Code 7)
   - Verify deposit meets minimum: `min_deposit()`
   - Verify deposit doesn't exceed per-user limit: `max_deposit_per_user()`
   - Check user's current deposits: `user_deposited(user_address)`
   - **Fix:** Adjust deposit amount to be within `[min_deposit, max_deposit_per_user - user_deposited]`

4. **Check Funding Target** (Error: `FundingTargetExceeded` - Code 46)
   - During `Funding` state, deposits cannot exceed the funding target
   - Call `funding_target()` and `total_assets()` to check remaining capacity
   - **Fix:** Reduce deposit amount to fit within remaining capacity: `funding_target - total_assets`

5. **Check Vault Pause Status** (Error: `VaultPaused` - Code 11)
   - Verify vault is not paused: `paused()`
   - **Fix:** Wait for admin/operator to unpause the vault

6. **Check Blacklist Status** (Error: `AddressBlacklisted` - Code 14)
   - Verify neither caller nor receiver is blacklisted
   - Call `is_blacklisted(address)` for both addresses
   - **Fix:** Contact compliance officer to resolve blacklist status

7. **Check Asset Allowance**
   - Ensure vault has sufficient allowance to transfer assets from caller
   - **Fix:** Approve vault contract to spend assets before depositing

**Related Error Codes:**
- `NotKYCVerified` (1)
- `InvalidVaultState` (5)
- `BelowMinimumDeposit` (6)
- `ExceedsMaximumDeposit` (7)
- `VaultPaused` (11)
- `ZeroAmount` (13)
- `AddressBlacklisted` (14)
- `FundingTargetExceeded` (46)

---

### Scenario 2: Withdrawal/Redemption Transaction Fails

**Symptoms:**
- Transaction reverts when attempting to withdraw assets or redeem shares
- Error code returned from `withdraw()` or `redeem()` call

**Quick Diagnosis Checklist:**

1. **Check Share Balance** (Error: `InsufficientBalance` - Code 20)
   - Verify user has sufficient shares: `balance(user_address)`
   - **Fix:** Reduce withdrawal amount or wait for deposits to settle

2. **Check Vault State** (Error: `InvalidVaultState` - Code 5)
   - Withdrawals are allowed in `Active` and `Matured` states
   - Call `vault_state()` to check current state
   - **Fix:** Wait for vault to enter appropriate state

3. **Check Freeze Flags** (Error: `VaultPaused` - Code 11)
   - Verify withdraw/redeem operations are not frozen
   - Call `freeze_flags()` and check if `FREEZE_WITHDRAW_REDEEM` (2) is set
   - **Fix:** Wait for admin/operator to unfreeze operations

4. **Check Blacklist Status** (Error: `AddressBlacklisted` - Code 14)
   - Verify neither owner nor receiver is blacklisted
   - Call `is_blacklisted(address)` for both addresses
   - **Fix:** Contact compliance officer to resolve blacklist status

5. **Check Allowance for `redeem_from`** (Error: `InsufficientAllowance` - Code 19)
   - If using `redeem_from`, verify spender has sufficient allowance
   - Call `allowance(owner, spender)`
   - **Fix:** Owner must approve spender via `approve()` before redemption

6. **Check Pending Yield** (Error: `BurnRequiresYieldClaim` - Code 32)
   - Some configurations require claiming yield before burning shares
   - Call `pending_yield(user_address)` to check unclaimed yield
   - **Fix:** Call `claim_yield()` before attempting withdrawal/redemption

7. **Check Amount Validity** (Error: `ZeroAmount` - Code 13 or `PreviewZeroAssets` - Code 48)
   - Verify withdrawal amount is positive and non-zero
   - Verify shares convert to non-zero assets at current price
   - **Fix:** Increase withdrawal amount or wait for share price to increase

**Related Error Codes:**
- `InvalidVaultState` (5)
- `VaultPaused` (11)
- `ZeroAmount` (13)
- `AddressBlacklisted` (14)
- `InsufficientAllowance` (19)
- `InsufficientBalance` (20)
- `BurnRequiresYieldClaim` (32)
- `PreviewZeroAssets` (48)

---

### Scenario 3: Yield Claim Transaction Fails

**Symptoms:**
- Transaction reverts when attempting to claim yield
- Error code returned from `claim_yield()` call

**Quick Diagnosis Checklist:**

1. **Check Pending Yield** (Error: `NoYieldToClaim` - Code 9)
   - Verify user has unclaimed yield: `pending_yield(user_address)`
   - **Fix:** Wait for yield distribution or verify you held shares during yield epochs

2. **Check Vault State** (Error: `InvalidVaultState` - Code 5)
   - Yield claiming is allowed in `Active` and `Matured` states
   - Call `vault_state()` to check current state
   - **Fix:** Wait for vault to enter appropriate state

3. **Check Freeze Flags** (Error: `VaultPaused` - Code 11)
   - Verify yield operations are not frozen
   - Call `freeze_flags()` and check if `FREEZE_YIELD` (4) is set
   - **Fix:** Wait for admin/operator to unfreeze yield operations

4. **Check Share Balance History**
   - Yield is calculated based on share balance at each epoch
   - Call `get_user_yield_history(user, start_epoch, end_epoch)` to see per-epoch breakdown
   - **Fix:** Ensure you held shares during the epochs you're trying to claim

**Related Error Codes:**
- `InvalidVaultState` (5)
- `NoYieldToClaim` (9)
- `VaultPaused` (11)

---

### Scenario 4: Early Redemption Request Fails

**Symptoms:**
- Transaction reverts when attempting to request early redemption
- Error code returned from `request_early_redemption()` call

**Quick Diagnosis Checklist:**

1. **Check Vault State** (Error: `InvalidVaultState` - Code 5)
   - Early redemption is only available in `Active` state
   - Call `vault_state()` to check current state
   - **Fix:** Wait for vault to enter `Active` state

2. **Check Share Balance** (Error: `InsufficientBalance` - Code 20)
   - Verify user has sufficient shares: `balance(user_address)`
   - **Fix:** Reduce redemption amount to match available balance

3. **Check Freeze Status** (Error: `VaultPaused` - Code 11)
   - Verify withdraw/redeem operations are not frozen
   - Call `freeze_flags()` and check if `FREEZE_WITHDRAW_REDEEM` (2) is set
   - **Fix:** Wait for admin/operator to unfreeze operations

4. **Check Blacklist Status** (Error: `AddressBlacklisted` - Code 14)
   - Verify user is not blacklisted: `is_blacklisted(user_address)`
   - **Fix:** Contact compliance officer to resolve blacklist status

5. **Check Amount Validity** (Error: `ZeroAmount` - Code 13)
   - Verify redemption amount is positive and non-zero
   - **Fix:** Provide a positive non-zero share amount

6. **Use Precheck Function**
   - Call `can_request_early_redemption(user_address)` for detailed validation
   - Returns `Pass` or `Fail(reason)` with specific failure reason
   - **Fix:** Address the specific failure reason returned

**Related Error Codes:**
- `InvalidVaultState` (5)
- `VaultPaused` (11)
- `ZeroAmount` (13)
- `AddressBlacklisted` (14)
- `InsufficientBalance` (20)

---

### Scenario 5: Vault Activation Fails

**Symptoms:**
- Transaction reverts when operator attempts to activate vault
- Error code returned from `activate_vault()` call

**Quick Diagnosis Checklist:**

1. **Check Operator Permissions** (Error: `NotOperator` - Code 3)
   - Verify caller has operator role: `is_operator(caller)` or `has_role(caller, LifecycleManager)`
   - **Fix:** Use an authorized operator account or request role from admin

2. **Check Vault State** (Error: `InvalidVaultState` - Code 5)
   - Vault must be in `Funding` state to activate
   - Call `vault_state()` to check current state
   - **Fix:** Ensure vault is in `Funding` state before activation

3. **Check Funding Target** (Error: `FundingTargetNotMet` - Code 10)
   - If funding target is set, it must be met before activation
   - Call `funding_target()` and `total_assets()` to check progress
   - Call `is_funding_target_met()` for quick check
   - **Fix:** Wait for more deposits or admin may adjust funding target via `set_funding_target()`

4. **Check Funding Deadline** (Error: `FundingDeadlinePassed` - Code 16)
   - If funding deadline is set and has passed, vault cannot be activated
   - Call `funding_deadline()` to check deadline timestamp
   - **Fix:** If deadline passed without meeting target, use `cancel_funding()` instead

**Related Error Codes:**
- `NotOperator` (3)
- `InvalidVaultState` (5)
- `FundingTargetNotMet` (10)
- `FundingDeadlinePassed` (16)

---

## Operator Scenarios

### Scenario 6: Yield Distribution Fails

**Symptoms:**
- Transaction reverts when operator attempts to distribute yield
- Error code returned from `distribute_yield()` call

**Quick Diagnosis Checklist:**

1. **Check Operator Permissions** (Error: `NotOperator` - Code 3)
   - Verify caller has operator role: `is_operator(caller)` or `has_role(caller, YieldOperator)`
   - **Fix:** Use an authorized operator account or request role from admin

2. **Check Vault State** (Error: `InvalidVaultState` - Code 5)
   - Yield can only be distributed in `Active` state
   - Call `vault_state()` to check current state
   - **Fix:** Ensure vault is activated before distributing yield

3. **Check Shareholders** (Error: `NoShareholders` - Code 50)
   - Cannot distribute yield when total supply is zero
   - Call `total_supply()` to check if there are any shareholders
   - **Fix:** Wait for deposits before distributing yield

4. **Check Yield Amount** (Error: `ZeroAmount` - Code 13)
   - Yield amount must be positive and non-zero
   - **Fix:** Provide a positive non-zero yield amount

5. **Check Asset Allowance**
   - Ensure operator has approved vault to transfer yield assets
   - **Fix:** Approve vault contract to spend yield assets before distribution

**Related Error Codes:**
- `NotOperator` (3)
- `InvalidVaultState` (5)
- `ZeroAmount` (13)
- `NoShareholders` (50)

---

## Admin Scenarios

### Scenario 7: Configuration Update Fails

**Symptoms:**
- Transaction reverts when admin attempts to update vault configuration
- Error code returned from configuration functions

**Quick Diagnosis Checklist:**

1. **Check Admin Permissions** (Error: `NotAdmin` - Code 4)
   - Verify caller is the admin: `admin()`
   - **Fix:** Use the admin account for configuration operations

2. **Check Address Validity** (Error: `ZeroAddress` - Code 12)
   - Verify address parameters are not zero-equivalent (contract's own address)
   - **Fix:** Provide valid non-zero addresses

3. **Check Deposit Limits** (Error: `InvalidDepositLimits` - Code 33)
   - When setting deposit limits, ensure `min_deposit ≤ max_deposit_per_user`
   - **Fix:** Adjust limits to satisfy the constraint

4. **Check Fee Limits** (Error: `FeeTooHigh` - Code 22)
   - Early redemption fee must be ≤ 1000 basis points (10%)
   - **Fix:** Reduce fee to 1000 bps or below

5. **Check Timelock Requirements** (Error: `TimelockDelayNotPassed` - Code 35)
   - Critical operations require timelock delay
   - Call `get_timelock_action(action_id)` to check status
   - **Fix:** Wait for timelock delay period to expire before executing

**Related Error Codes:**
- `NotAdmin` (4)
- `ZeroAddress` (12)
- `FeeTooHigh` (22)
- `InvalidDepositLimits` (33)
- `TimelockDelayNotPassed` (35)

---

## Factory Scenarios

### Scenario 8: Vault Creation Fails

**Symptoms:**
- Transaction reverts when creating a new vault through factory
- Error code returned from `create_single_rwa_vault()` call

**Quick Diagnosis Checklist:**

1. **Check Operator Permissions** (Error: `NotAuthorized` - Code 3)
   - Verify caller has operator role or is admin
   - Call `is_operator(caller)` or `has_role(caller, FullOperator)`
   - **Fix:** Use an authorized operator account or request role from admin

2. **Check Initialization Parameters** (Error: `InvalidInitParams` - Code 6)
   - Verify maturity date is in the future
   - Verify early redemption fee ≤ 1000 bps (10%)
   - Verify min_deposit ≥ 0 and funding_target ≥ 0
   - Verify min_deposit ≤ max_deposit_per_user (if both > 0)
   - **Fix:** Correct invalid parameters

3. **Check Batch Size** (Error: `BatchTooLarge` - Code 7)
   - Batch vault creation is limited to 10 vaults per transaction
   - **Fix:** Reduce batch size to 10 or fewer vaults

4. **Check WASM Hash** (Error: `InvalidWasmHash` - Code 8)
   - WASM hash must not be all zeros
   - **Fix:** Upload vault WASM and use the returned hash

5. **Check Migration Status** (Error: `MigrationRequired` - Code 9)
   - Factory storage schema must be current
   - **Fix:** Admin must call `migrate()` before creating vaults

**Related Error Codes:**
- `NotAuthorized` (3)
- `InvalidInitParams` (6)
- `BatchTooLarge` (7)
- `InvalidWasmHash` (8)
- `MigrationRequired` (9)

---

## General Debugging Tips

### Check Contract State
Always start by checking the current state of the contract:
```bash
# Vault state
stellar contract invoke --id <VAULT> -- vault_state

# Pause status
stellar contract invoke --id <VAULT> -- paused

# Freeze flags
stellar contract invoke --id <VAULT> -- freeze_flags
```

### Check User Status
Verify user-specific conditions:
```bash
# KYC status
stellar contract invoke --id <VAULT> -- is_kyc_verified --user <ADDRESS>

# Blacklist status
stellar contract invoke --id <VAULT> -- is_blacklisted --address <ADDRESS>

# Share balance
stellar contract invoke --id <VAULT> -- balance --id <ADDRESS>

# Pending yield
stellar contract invoke --id <VAULT> -- pending_yield --user <ADDRESS>
```

### Check Vault Configuration
Review vault configuration:
```bash
# Deposit limits
stellar contract invoke --id <VAULT> -- min_deposit
stellar contract invoke --id <VAULT> -- max_deposit_per_user

# Funding status
stellar contract invoke --id <VAULT> -- funding_target
stellar contract invoke --id <VAULT> -- total_assets
stellar contract invoke --id <VAULT> -- is_funding_target_met

# Maturity
stellar contract invoke --id <VAULT> -- maturity_date
stellar contract invoke --id <VAULT> -- is_matured
```

### Use Preview Functions
Many operations have preview functions that can help diagnose issues:
```bash
# Preview deposit
stellar contract invoke --id <VAULT> -- preview_deposit --assets <AMOUNT>

# Preview redemption
stellar contract invoke --id <VAULT> -- preview_redeem --shares <AMOUNT>

# Preview early redemption fee
stellar contract invoke --id <VAULT> -- estimate_early_redemption_fee --shares <AMOUNT>

# Check early redemption eligibility
stellar contract invoke --id <VAULT> -- can_request_early_redemption --user <ADDRESS>
```

### Check Permissions
Verify role assignments:
```bash
# Check admin
stellar contract invoke --id <VAULT> -- admin

# Check operator status
stellar contract invoke --id <VAULT> -- is_operator --account <ADDRESS>

# Check specific role
stellar contract invoke --id <VAULT> -- has_role --addr <ADDRESS> --role <ROLE>
```

---

## Getting Help

If you've followed the troubleshooting steps and still encounter issues:

1. **Check the Error Catalog** in the main README for detailed error descriptions
2. **Review Contract Events** emitted during the failed transaction for additional context
3. **Verify Network Status** - ensure you're connected to the correct network (testnet/mainnet)
4. **Check Gas Limits** - some operations may require higher gas limits
5. **Contact Support** with:
   - Transaction hash
   - Error code received
   - Contract address
   - Steps to reproduce
   - Results from relevant diagnostic commands above
