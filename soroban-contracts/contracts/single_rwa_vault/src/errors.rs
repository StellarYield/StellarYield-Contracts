//! Contract error codes.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotKYCVerified = 1,
    ZKMEVerifierNotSet = 2,
    NotOperator = 3,
    NotAdmin = 4,
    InvalidVaultState = 5,
    BelowMinimumDeposit = 6,
    ExceedsMaximumDeposit = 7,
    NotMatured = 8,
    NoYieldToClaim = 9,
    FundingTargetNotMet = 10,
    VaultPaused = 11,
    ZeroAddress = 12,
    ZeroAmount = 13,
    AddressBlacklisted = 14,
    /// Reentrancy detected — a guarded function was called while already executing.
    Reentrant = 15,
    /// Funding deadline has already passed; cannot activate vault.
    FundingDeadlinePassed = 16,
    /// Funding deadline has not yet passed; cannot cancel funding early.
    FundingDeadlineNotPassed = 17,
    /// Caller holds no shares to refund.
    NoSharesToRefund = 18,
    /// Spender allowance is too low to cover the requested transfer.
    InsufficientAllowance = 19,
    /// Account balance is too low to cover the requested operation.
    InsufficientBalance = 20,
    /// Operation has already been processed and cannot be repeated.
    AlreadyProcessed = 21,
    /// Requested fee exceeds the permitted maximum.
    FeeTooHigh = 22,
    /// Price aggregator is not supported or not recognised.
    AggregatorNotSupported = 23,
    /// The specified redemption request ID is invalid or not found.
    InvalidRedemptionRequest = 24,
    /// Operation or component is not supported.
    NotSupported = 25,
    /// Invalid initialization parameters provided to the constructor.
    InvalidInitParams = 26,
    /// Vault cannot be closed because it still contains shares/assets.
    VaultNotEmpty = 27,
    /// Shares are still within the lock-up period and cannot be transferred.
    SharesLocked = 33,
    /// Epoch range is invalid (zero start, start > end, or exceeds max batch of 50).
    InvalidEpochRange = 28,
    /// Vault is not in Emergency state.
    NotInEmergency = 29,
    /// User has already claimed their emergency distribution.
    AlreadyClaimedEmergency = 30,
    /// Storage schema version is outdated; migrate() must be called.
    MigrationRequired = 31,
    /// Burn requires pending yield to be claimed first (Option A).
    BurnRequiresYieldClaim = 32,
}
