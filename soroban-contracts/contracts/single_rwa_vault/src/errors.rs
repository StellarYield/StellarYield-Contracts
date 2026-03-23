//! Contract error codes.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotKYCVerified          = 1,
    ZKMEVerifierNotSet      = 2,
    NotOperator             = 3,
    NotAdmin                = 4,
    InvalidVaultState       = 5,
    BelowMinimumDeposit     = 6,
    ExceedsMaximumDeposit   = 7,
    NotMatured              = 8,
    NoYieldToClaim          = 9,
    FundingTargetNotMet     = 10,
    VaultPaused             = 11,
    ZeroAddress             = 12,
    ZeroAmount              = 13,
    AddressBlacklisted      = 14,
    /// A guarded function was called while it (or another guarded function)
    /// was already executing — reentrancy is not permitted.
    Reentrant               = 15,
}
