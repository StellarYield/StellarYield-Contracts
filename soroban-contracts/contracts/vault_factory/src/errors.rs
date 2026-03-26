//! Contract error codes for VaultFactory.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    VaultAlreadyExists = 1,
    VaultNotFound = 2,
    NotAuthorized = 3,
    /// Vault must be set inactive before it can be removed.
    VaultIsActive = 4,
    /// Requested operation is not supported.
    NotSupported = 5,
    /// Invalid initialization parameters provided.
    InvalidInitParams = 6,
    /// Batch size exceeds the maximum allowed limit.
    BatchTooLarge = 7,
}
