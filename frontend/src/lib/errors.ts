import { describeContractError } from "@stellaryield/sdk";

/** Extract `#N` from a Soroban `Error(Contract, #N)` string. */
function extractContractCode(message: string): number | undefined {
  const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Turn any thrown value from a simulate/sign/send flow into a message worth
 * showing a user. Falls back to the raw text when the shape is unfamiliar.
 */
export function describeError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);

  // Text-based checks run FIRST. Contract error codes are per-contract, so the
  // numeric table below is only meaningful for the vault and factory — a token
  // contract reusing #13 for "trustline missing" must not be reported as the
  // vault's ZeroAmount.
  if (/trustline entry is missing|no trustline|trustline/i.test(raw)) {
    return "This account has no trustline for the vault's asset. Add the asset in your wallet before depositing.";
  }
  if (/User declined|denied|rejected/i.test(raw)) {
    return "Transaction was declined in the wallet.";
  }
  if (/Freighter is not|not connected|not installed/i.test(raw)) {
    return "Freighter wallet is not available. Install it and reload the page.";
  }
  if (/txInsufficientBalance|insufficient balance/i.test(raw)) {
    return "Account balance is too low to cover this transaction.";
  }
  if (/account not found|MissingValue/i.test(raw)) {
    return "Account not found on this network. Fund it with the friendbot first.";
  }

  const code = extractContractCode(raw);
  if (code !== undefined) {
    return describeContractError(code) ?? `Contract rejected the call (error #${code}).`;
  }

  // Simulation errors are often long multi-line diagnostics; keep the first line.
  return raw.split("\n")[0].slice(0, 240);
}
