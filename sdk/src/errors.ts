export interface ContractErrorInfo {
  variant: string;
  message: string;
}

/**
 * Human-readable messages and variants for `single_rwa_vault::errors::Error` codes.
 * Matches existing messages in frontend/src/lib/errors.ts.
 */
export const VAULT_ERRORS: Record<number, ContractErrorInfo> = {
  1: { variant: "NotKYCVerified", message: "This address has not passed KYC for the vault's zkMe verifier." },
  3: { variant: "NotOperator", message: "Caller is not an operator on this vault." },
  4: { variant: "NotAdmin", message: "Caller is not the vault admin." },
  5: { variant: "InvalidVaultState", message: "The vault is not in a state that allows this action." },
  6: { variant: "BelowMinimumDeposit", message: "Amount is below the vault's minimum deposit." },
  7: { variant: "ExceedsMaximumDeposit", message: "Amount would exceed the per-user deposit cap." },
  8: { variant: "NotMatured", message: "The vault has not matured yet." },
  9: { variant: "NoYieldToClaim", message: "There is no yield available to claim." },
  10: { variant: "FundingTargetNotMet", message: "The funding target has not been met yet." },
  11: { variant: "VaultPaused", message: "The vault is paused." },
  12: { variant: "ZeroAddress", message: "Invalid (zero) address." },
  13: { variant: "ZeroAmount", message: "Amount must be greater than zero." },
  14: { variant: "AddressBlacklisted", message: "This address is blacklisted on the vault." },
  15: { variant: "Reentrant", message: "Reentrant call detected." },
  16: { variant: "FundingDeadlinePassed", message: "The funding deadline has already passed." },
  17: { variant: "FundingDeadlineNotPassed", message: "The funding deadline has not passed yet." },
  18: { variant: "NoSharesToRefund", message: "No shares available to refund." },
  19: { variant: "InsufficientAllowance", message: "Share allowance is too low for this transfer." },
  20: { variant: "InsufficientBalance", message: "Insufficient balance." },
  21: { variant: "AlreadyProcessed", message: "This request has already been processed." },
  22: { variant: "FeeTooHigh", message: "The requested fee exceeds the permitted maximum." },
  24: { variant: "InvalidRedemptionRequest", message: "That redemption request does not exist." },
  25: { variant: "NotSupported", message: "Operation not supported." },
  26: { variant: "InvalidInitParams", message: "Invalid initialization parameters." },
  27: { variant: "VaultNotEmpty", message: "The vault still holds shares and cannot be closed." },
  28: { variant: "InvalidEpochRange", message: "Invalid epoch range." },
  29: { variant: "NotInEmergency", message: "The vault is not in an emergency state." },
  30: { variant: "AlreadyClaimedEmergency", message: "Emergency distribution already claimed." },
  31: { variant: "MigrationRequired", message: "The vault requires migration before use." },
  32: { variant: "BurnRequiresYieldClaim", message: "Claim your pending yield before burning shares." },
  33: { variant: "InvalidDepositLimits", message: "Invalid deposit limits." },
  34: { variant: "TimelockActionNotFound", message: "Timelock action not found or invalid." },
  35: { variant: "TimelockDelayNotPassed", message: "Timelock delay has not passed yet." },
  36: { variant: "TimelockActionAlreadyExecuted", message: "Timelock action has already been executed." },
  37: { variant: "TimelockActionCancelled", message: "Timelock action has been cancelled." },
  38: { variant: "TimelockAdminOnly", message: "Only admin can perform timelock operations." },
  39: { variant: "NotEmergencySigner", message: "Caller is not in the emergency signers list." },
  40: { variant: "ProposalNotFound", message: "The referenced emergency proposal does not exist." },
  41: { variant: "ProposalExpired", message: "The emergency proposal has passed its expiry timeout." },
  42: { variant: "ProposalAlreadyExecuted", message: "The emergency proposal has already been executed." },
  43: { variant: "ThresholdNotMet", message: "Approval threshold has not been reached yet." },
  44: { variant: "AlreadyApproved", message: "Signer has already approved this proposal." },
  45: { variant: "InvalidThreshold", message: "Threshold must be >= 1 and <= number of signers." },
  46: { variant: "FundingTargetExceeded", message: "Deposit would push the vault past its funding target." },
  47: { variant: "PreviewZeroShares", message: "Amount is too small to mint any shares." },
  48: { variant: "PreviewZeroAssets", message: "Share amount converts to zero assets." },
  49: { variant: "TransferExemptionLimitExceeded", message: "Too many transfer-exempt addresses configured." },
  50: { variant: "NoShareholders", message: "Cannot distribute yield while the vault has no shareholders." },
  51: { variant: "YieldShortfallNotFound", message: "No yield shortfall recorded for this user." },
  52: { variant: "InsufficientShortfall", message: "The resolution amount is greater than the recorded shortfall." },
  53: { variant: "MaxInvestorsReached", message: "Maximum number of investors reached." },
  54: { variant: "InsufficientVaultBalance", message: "Vault balance is insufficient for the requested transfer." },
};

/**
 * Human-readable messages and variants for `vault_factory::errors::Error` codes.
 */
export const FACTORY_ERRORS: Record<number, ContractErrorInfo> = {
  1: { variant: "VaultAlreadyExists", message: "Vault already exists." },
  2: { variant: "VaultNotFound", message: "Vault not found." },
  3: { variant: "NotAuthorized", message: "Caller is not authorized." },
  4: { variant: "VaultIsActive", message: "Vault must be set inactive before it can be removed." },
  5: { variant: "NotSupported", message: "Requested operation is not supported." },
  6: { variant: "InvalidInitParams", message: "Invalid initialization parameters provided." },
  7: { variant: "BatchTooLarge", message: "Batch size exceeds the maximum allowed limit." },
  8: { variant: "InvalidWasmHash", message: "Provided WASM hash is invalid." },
  9: { variant: "MigrationRequired", message: "Storage schema version is outdated; migrate() must be called." },
};

export const CONTRACT_ERRORS = {
  ...VAULT_ERRORS,
};

/**
 * Return human-readable error description for a contract error code.
 */
export function describeContractError(code: number): string | undefined {
  return VAULT_ERRORS[code]?.message;
}
