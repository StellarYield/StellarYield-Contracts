# Contract Error Codes

Canonical reference of all `#[contracterror]` variants defined in:
- [`soroban-contracts/contracts/single_rwa_vault/src/errors.rs`](../soroban-contracts/contracts/single_rwa_vault/src/errors.rs)
- [`soroban-contracts/contracts/vault_factory/src/errors.rs`](../soroban-contracts/contracts/vault_factory/src/errors.rs)

---

## `single_rwa_vault`

| Code | Variant | Condition |
| --- | --- | --- |
| 1 | `NotKYCVerified` | User has not passed KYC verification via `zkme_verifier.has_approved(cooperator, user)`. |
| 3 | `NotOperator` | Caller lacks the required `Role` (and is neither `FullOperator` nor `Admin`). |
| 4 | `NotAdmin` | Caller is not the contract admin. |
| 5 | `InvalidVaultState` | Operation is not allowed in the vault's current `VaultState`. |
| 6 | `BelowMinimumDeposit` | Deposit asset amount is below `min_deposit`. |
| 7 | `ExceedsMaximumDeposit` | Deposit would exceed `max_deposit_per_user`. |
| 8 | `NotMatured` | Vault has not reached maturity (`VaultState::Matured` or maturity timestamp). |
| 9 | `NoYieldToClaim` | User has no unclaimed yield available for the target epoch(s). |
| 10 | `FundingTargetNotMet` | Funding target is not met on `activate_vault`, or is already met on `cancel_funding`. |
| 11 | `VaultPaused` | Vault is paused or the operation's freeze flag is active. |
| 12 | `ZeroAddress` | Address parameter is invalid (e.g., equals the contract's own address). |
| 13 | `ZeroAmount` | Amount or share quantity is zero or negative. |
| 14 | `AddressBlacklisted` | Caller, sender, receiver, or owner address is blacklisted. |
| 15 | `Reentrant` | Reentrancy detected — a guarded function was called while already executing. |
| 16 | `FundingDeadlinePassed` | Funding deadline has already passed; cannot activate vault. |
| 17 | `FundingDeadlineNotPassed` | Funding deadline has not yet passed; cannot cancel funding early. |
| 18 | `NoSharesToRefund` | Caller holds no shares to refund. |
| 19 | `InsufficientAllowance` | Spender allowance is too low to cover the requested transfer or burn. |
| 20 | `InsufficientBalance` | Account share balance is too low to cover the requested operation. |
| 21 | `AlreadyProcessed` | Operation or redemption request has already been processed and cannot be repeated. |
| 22 | `FeeTooHigh` | Requested fee exceeds the permitted maximum. |
| 24 | `InvalidRedemptionRequest` | The specified redemption request ID is invalid or not found. |
| 25 | `NotSupported` | Operation or component is not supported (e.g., single-key `emergency_withdraw` when multi-sig is active, or unimplemented timelock action type). |
| 26 | `InvalidInitParams` | Invalid initialization or configuration parameters (e.g., constructor params or reason string too long). |
| 27 | `VaultNotEmpty` | Vault cannot be closed because it still contains shares or assets. |
| 28 | `InvalidEpochRange` | Epoch range is invalid (zero start, start > end, or exceeds max batch of 50). |
| 29 | `NotInEmergency` | Vault is not in `Emergency` state. |
| 30 | `AlreadyClaimedEmergency` | User has already claimed their emergency distribution. |
| 31 | `MigrationRequired` | Storage schema version is outdated; `migrate()` must be called. |
| 32 | `BurnRequiresYieldClaim` | Burn requires pending yield to be claimed first. |
| 33 | `InvalidDepositLimits` | Deposit limits are negative or `min_deposit > max_deposit_per_user` (when both are non-zero). |
| 34 | `TimelockActionNotFound` | Timelock action not found or invalid. |
| 35 | `TimelockDelayNotPassed` | Timelock delay has not passed yet. |
| 36 | `TimelockActionAlreadyExecuted` | Timelock action has already been executed. |
| 37 | `TimelockActionCancelled` | Timelock action has been cancelled. |
| 38 | `TimelockAdminOnly` | Operation requires timelock/admin or vault must be paused first (`transfer_admin` or unpaused `emergency_withdraw`). |
| 39 | `NotEmergencySigner` | Caller is not in the configured emergency signers list. |
| 40 | `ProposalNotFound` | The referenced emergency proposal does not exist. |
| 41 | `ProposalExpired` | The emergency proposal has passed its expiry timeout. |
| 42 | `ProposalAlreadyExecuted` | The emergency proposal has already been executed. |
| 43 | `ThresholdNotMet` | Approval threshold has not been reached yet. |
| 44 | `AlreadyApproved` | Signer has already approved this proposal. |
| 45 | `InvalidThreshold` | Threshold must be `>= 1` and `<=` number of signers. |
| 46 | `FundingTargetExceeded` | Vault total assets exceeds the funding target during the funding phase. |
| 47 | `PreviewZeroShares` | Amount corresponds to zero shares during preview. |
| 48 | `PreviewZeroAssets` | Shares correspond to zero assets during preview. |
| 49 | `TransferExemptionLimitExceeded` | Too many transfer-exempt addresses have been configured. |
| 50 | `NoShareholders` | Cannot distribute yield when there are no shareholders. |
| 51 | `YieldShortfallNotFound` | No yield shortfall is recorded for this user. |
| 52 | `InsufficientShortfall` | The resolution amount is greater than the recorded shortfall. |
| 53 | `MaxInvestorsReached` | Maximum number of investors reached. |
| 54 | `InsufficientVaultBalance` | Vault asset balance is insufficient for the requested transfer. |

---

## `vault_factory`

| Code | Variant | Condition |
| --- | --- | --- |
| 1 | `VaultAlreadyExists` | A vault with the same identifier or address is already registered in the factory. |
| 2 | `VaultNotFound` | The specified vault address is not registered in the factory. |
| 3 | `NotAuthorized` | Caller is not the factory admin (or lacks `FullOperator`/required role). |
| 4 | `VaultIsActive` | Vault must be set inactive via `set_vault_status` before it can be removed. |
| 5 | `NotSupported` | Requested operation is not supported (e.g., `create_aggregator_vault`). |
| 6 | `InvalidInitParams` | Invalid initialization or configuration parameters provided. |
| 7 | `BatchTooLarge` | Batch size exceeds the maximum allowed limit. |
| 8 | `InvalidWasmHash` | Provided WASM hash is invalid (e.g., all-zeros). |
| 9 | `MigrationRequired` | Storage schema version is outdated; `migrate()` must be called. |
