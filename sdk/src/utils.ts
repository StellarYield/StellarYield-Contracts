import type { VaultState } from "./types.js";

/**
 * Format a raw share balance (integer stroops/smallest unit) using vault decimals.
 */
export function formatShares(amount: bigint, decimals: number): string {
  if (decimals < 0 || decimals > 18) {
    throw new Error("decimals must be 0–18");
  }
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Simple annualized yield estimate: `(yield / principal) * (secondsPerYear / durationSeconds)`.
 * Returns a fraction (e.g. `0.05` for 5% APY) when `principal` and `durationSeconds` are positive.
 */
export function calculateYieldApy(
  yieldAmount: bigint,
  principal: bigint,
  durationSeconds: bigint,
): number {
  if (principal <= 0n || durationSeconds <= 0n) return 0;
  const secondsPerYear = 31_536_000n;
  const num = yieldAmount * secondsPerYear;
  const den = principal * durationSeconds;
  return Number(num) / Number(den);
}

/** True when the vault accepts normal deposits / is not terminal. */
export function isVaultActive(state: VaultState): boolean {
  return state === "Funding" || state === "Active";
}

/** True when users can redeem / withdraw (active investment or post-maturity). */
export function isVaultRedeemable(state: VaultState): boolean {
  return state === "Active" || state === "Matured";
}
