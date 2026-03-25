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
    /// Caller is not a configured emergency signer.
    NotEmergencySigner = 28,
    /// Emergency proposal ID not found.
    ProposalNotFound = 29,
    /// Emergency proposal has expired (past 24-hour window).
    ProposalExpired = 30,
    /// Threshold approvals not yet met; cannot execute.
    ThresholdNotMet = 31,
    /// Signer has already approved this proposal.
    AlreadyApproved = 32,
    /// Emergency proposal has already been executed.
    ProposalAlreadyExecuted = 33,
    /// Multi-sig is configured; use multi-sig functions instead of single-admin fallback.
    MultiSigConfigured = 34,
    /// No multi-sig configured; call set_emergency_signers first.
    NoMultiSigConfigured = 35,
    /// Invalid threshold: must be >= 1 and <= number of signers.
    InvalidThreshold = 36,
}
