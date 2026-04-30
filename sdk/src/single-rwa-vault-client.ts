import { Contract, nativeToScVal } from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";
import { scAddress, scI128, scU32, scU64 } from "./encode.js";
import type { SorobanOperation } from "./transaction.js";

/**
 * Typed invoke helpers for `SingleRWAVault`.
 * Method names match on-chain `contractimpl` entry points (snake_case).
 */
export class SingleRwaVaultClient {
  constructor(public readonly contractId: string) {}

  private call(method: string, ...args: xdr.ScVal[]): SorobanOperation {
    return new Contract(this.contractId).call(method, ...args);
  }

  // --- RWA / meta ---
  getRwaDetails(): SorobanOperation {
    return this.call("get_rwa_details");
  }
  rwaName(): SorobanOperation {
    return this.call("rwa_name");
  }
  rwaSymbol(): SorobanOperation {
    return this.call("rwa_symbol");
  }
  rwaDocumentUri(): SorobanOperation {
    return this.call("rwa_document_uri");
  }
  rwaCategory(): SorobanOperation {
    return this.call("rwa_category");
  }

  // --- KYC ---
  isKycVerified(user: string): SorobanOperation {
    return this.call("is_kyc_verified", scAddress(user));
  }
  zkmeVerifier(): SorobanOperation {
    return this.call("zkme_verifier");
  }
  getZkmeVerifier(): SorobanOperation {
    return this.call("get_zkme_verifier");
  }
  cooperator(): SorobanOperation {
    return this.call("cooperator");
  }
  getCooperator(): SorobanOperation {
    return this.call("get_cooperator");
  }
  setZkmeVerifier(caller: string, verifier: string): SorobanOperation {
    return this.call("set_zkme_verifier", scAddress(caller), scAddress(verifier));
  }
  setCooperator(caller: string, newCooperator: string): SorobanOperation {
    return this.call("set_cooperator", scAddress(caller), scAddress(newCooperator));
  }

  // --- ERC-4626 core ---
  deposit(caller: string, assets: bigint, receiver: string): SorobanOperation {
    return this.call("deposit", scAddress(caller), scI128(assets), scAddress(receiver));
  }
  mint(caller: string, shares: bigint, receiver: string): SorobanOperation {
    return this.call("mint", scAddress(caller), scI128(shares), scAddress(receiver));
  }
  withdraw(
    caller: string,
    assets: bigint,
    receiver: string,
    owner: string,
  ): SorobanOperation {
    return this.call(
      "withdraw",
      scAddress(caller),
      scI128(assets),
      scAddress(receiver),
      scAddress(owner),
    );
  }
  redeem(
    caller: string,
    shares: bigint,
    receiver: string,
    owner: string,
  ): SorobanOperation {
    return this.call(
      "redeem",
      scAddress(caller),
      scI128(shares),
      scAddress(receiver),
      scAddress(owner),
    );
  }
  previewDeposit(assets: bigint): SorobanOperation {
    return this.call("preview_deposit", scI128(assets));
  }
  previewMint(shares: bigint): SorobanOperation {
    return this.call("preview_mint", scI128(shares));
  }
  previewWithdraw(assets: bigint): SorobanOperation {
    return this.call("preview_withdraw", scI128(assets));
  }
  previewRedeem(shares: bigint): SorobanOperation {
    return this.call("preview_redeem", scI128(shares));
  }
  redemptionRequest(requestId: number): SorobanOperation {
    return this.call("redemption_request", scU32(requestId));
  }
  maxDeposit(receiver: string): SorobanOperation {
    return this.call("max_deposit", scAddress(receiver));
  }
  maxMint(receiver: string): SorobanOperation {
    return this.call("max_mint", scAddress(receiver));
  }
  maxWithdraw(owner: string): SorobanOperation {
    return this.call("max_withdraw", scAddress(owner));
  }
  maxRedeem(owner: string): SorobanOperation {
    return this.call("max_redeem", scAddress(owner));
  }
  totalAssets(): SorobanOperation {
    return this.call("total_assets");
  }

  // --- Yield ---
  distributeYield(caller: string, amount: bigint): SorobanOperation {
    return this.call("distribute_yield", scAddress(caller), scI128(amount));
  }
  claimYield(caller: string): SorobanOperation {
    return this.call("claim_yield", scAddress(caller));
  }
  claimYieldForEpoch(caller: string, epoch: number): SorobanOperation {
    return this.call("claim_yield_for_epoch", scAddress(caller), scU32(epoch));
  }
  pendingYield(user: string): SorobanOperation {
    return this.call("pending_yield", scAddress(user));
  }
  pendingYieldForEpoch(user: string, epoch: number): SorobanOperation {
    return this.call("pending_yield_for_epoch", scAddress(user), scU32(epoch));
  }
  currentEpoch(): SorobanOperation {
    return this.call("current_epoch");
  }
  epochYield(epoch: number): SorobanOperation {
    return this.call("epoch_yield", scU32(epoch));
  }
  totalYieldDistributed(): SorobanOperation {
    return this.call("total_yield_distributed");
  }
  totalYieldClaimed(user: string): SorobanOperation {
    return this.call("total_yield_claimed", scAddress(user));
  }

  // --- Lifecycle ---
  vaultState(): SorobanOperation {
    return this.call("vault_state");
  }
  activateVault(operator: string): SorobanOperation {
    return this.call("activate_vault", scAddress(operator));
  }
  cancelFunding(caller: string): SorobanOperation {
    return this.call("cancel_funding", scAddress(caller));
  }
  refund(caller: string): SorobanOperation {
    return this.call("refund", scAddress(caller));
  }
  fundingDeadline(): SorobanOperation {
    return this.call("funding_deadline");
  }
  matureVault(caller: string): SorobanOperation {
    return this.call("mature_vault", scAddress(caller));
  }
  closeVault(caller: string): SorobanOperation {
    return this.call("close_vault", scAddress(caller));
  }
  setMaturityDate(caller: string, timestamp: bigint): SorobanOperation {
    return this.call("set_maturity_date", scAddress(caller), scU64(timestamp));
  }
  maturityDate(): SorobanOperation {
    return this.call("maturity_date");
  }
  fundingTarget(): SorobanOperation {
    return this.call("funding_target");
  }
  isFundingTargetMet(): SorobanOperation {
    return this.call("is_funding_target_met");
  }
  timeToMaturity(): SorobanOperation {
    return this.call("time_to_maturity");
  }
  minDeposit(): SorobanOperation {
    return this.call("min_deposit");
  }
  getMinDeposit(): SorobanOperation {
    return this.call("get_min_deposit");
  }
  maxDepositPerUser(): SorobanOperation {
    return this.call("max_deposit_per_user");
  }
  userDeposited(user: string): SorobanOperation {
    return this.call("user_deposited", scAddress(user));
  }
  setDepositLimits(
    caller: string,
    minAmount: bigint,
    maxAmount: bigint,
  ): SorobanOperation {
    return this.call(
      "set_deposit_limits",
      scAddress(caller),
      scI128(minAmount),
      scI128(maxAmount),
    );
  }

  redeemAtMaturity(
    caller: string,
    shares: bigint,
    receiver: string,
    owner: string,
  ): SorobanOperation {
    return this.call(
      "redeem_at_maturity",
      scAddress(caller),
      scI128(shares),
      scAddress(receiver),
      scAddress(owner),
    );
  }
  requestEarlyRedemption(caller: string, shares: bigint): SorobanOperation {
    return this.call("request_early_redemption", scAddress(caller), scI128(shares));
  }
  processEarlyRedemption(operator: string, requestId: number): SorobanOperation {
    return this.call(
      "process_early_redemption",
      scAddress(operator),
      scU32(requestId),
    );
  }
  cancelEarlyRedemption(caller: string, requestId: number): SorobanOperation {
    return this.call("cancel_early_redemption", scAddress(caller), scU32(requestId));
  }
  rejectEarlyRedemption(operator: string, requestId: number): SorobanOperation {
    return this.call("reject_early_redemption", scAddress(operator), scU32(requestId));
  }
  earlyRedemptionFeeBps(): SorobanOperation {
    return this.call("early_redemption_fee_bps");
  }
  setEarlyRedemptionFee(operator: string, feeBps: number): SorobanOperation {
    return this.call("set_early_redemption_fee", scAddress(operator), scU32(feeBps));
  }

  // --- Admin / ACL ---
  admin(): SorobanOperation {
    return this.call("admin");
  }
  isOperator(account: string): SorobanOperation {
    return this.call("is_operator", scAddress(account));
  }
  setOperator(caller: string, operator: string, status: boolean): SorobanOperation {
    return this.call(
      "set_operator",
      scAddress(caller),
      scAddress(operator),
      nativeToScVal(status),
    );
  }
  transferAdmin(caller: string, newAdmin: string): SorobanOperation {
    return this.call("transfer_admin", scAddress(caller), scAddress(newAdmin));
  }
  setBlacklisted(caller: string, address: string, status: boolean): SorobanOperation {
    return this.call(
      "set_blacklisted",
      scAddress(caller),
      scAddress(address),
      nativeToScVal(status),
    );
  }
  isBlacklisted(address: string): SorobanOperation {
    return this.call("is_blacklisted", scAddress(address));
  }
  transferRequiresKyc(): SorobanOperation {
    return this.call("transfer_requires_kyc");
  }
  setTransferRequiresKyc(caller: string, enabled: boolean): SorobanOperation {
    return this.call(
      "set_transfer_requires_kyc",
      scAddress(caller),
      nativeToScVal(enabled),
    );
  }
  pause(caller: string, reason: string): SorobanOperation {
    return this.call("pause", scAddress(caller), nativeToScVal(reason));
  }
  unpause(caller: string): SorobanOperation {
    return this.call("unpause", scAddress(caller));
  }
  paused(): SorobanOperation {
    return this.call("paused");
  }
  emergencyWithdraw(caller: string, recipient: string): SorobanOperation {
    return this.call("emergency_withdraw", scAddress(caller), scAddress(recipient));
  }

  // --- View ---
  asset(): SorobanOperation {
    return this.call("asset");
  }
  currentApy(): SorobanOperation {
    return this.call("current_apy");
  }
  expectedApy(): SorobanOperation {
    return this.call("expected_apy");
  }
  setFundingTarget(caller: string, target: bigint): SorobanOperation {
    return this.call("set_funding_target", scAddress(caller), scI128(target));
  }

  // --- SEP-41 share token ---
  allowance(from: string, spender: string): SorobanOperation {
    return this.call("allowance", scAddress(from), scAddress(spender));
  }
  approve(
    from: string,
    spender: string,
    amount: bigint,
    expirationLedger: number,
  ): SorobanOperation {
    return this.call(
      "approve",
      scAddress(from),
      scAddress(spender),
      scI128(amount),
      scU32(expirationLedger),
    );
  }
  balance(id: string): SorobanOperation {
    return this.call("balance", scAddress(id));
  }
  escrowedBalance(id: string): SorobanOperation {
    return this.call("escrowed_balance", scAddress(id));
  }
  transfer(from: string, to: string, amount: bigint): SorobanOperation {
    return this.call("transfer", scAddress(from), scAddress(to), scI128(amount));
  }
  transferFrom(
    spender: string,
    from: string,
    to: string,
    amount: bigint,
  ): SorobanOperation {
    return this.call(
      "transfer_from",
      scAddress(spender),
      scAddress(from),
      scAddress(to),
      scI128(amount),
    );
  }
  burn(from: string, amount: bigint): SorobanOperation {
    return this.call("burn", scAddress(from), scI128(amount));
  }
  burnFrom(spender: string, from: string, amount: bigint): SorobanOperation {
    return this.call("burn_from", scAddress(spender), scAddress(from), scI128(amount));
  }
  decimals(): SorobanOperation {
    return this.call("decimals");
  }
  name(): SorobanOperation {
    return this.call("name");
  }
  symbol(): SorobanOperation {
    return this.call("symbol");
  }
  totalSupply(): SorobanOperation {
    return this.call("total_supply");
  }

  /** Low-level escape hatch. */
  invoke(method: string, ...args: xdr.ScVal[]): SorobanOperation {
    return this.call(method, ...args);
  }
}
