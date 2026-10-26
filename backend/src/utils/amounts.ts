/**
 * Utility functions for converting between integer base units (e.g. stroops)
 * and human-readable decimal strings.
 */

/**
 * Convert a bigint in base units to a human-readable decimal string with fixed decimals.
 * e.g. toDecimal(12345678n, 7) => "1.2345678"
 */
export function toDecimal(amount: bigint, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error("Decimals must be a non-negative integer");
  }

  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;
  const s = absAmount.toString();

  let formatted: string;
  if (decimals === 0) {
    formatted = s;
  } else if (s.length <= decimals) {
    const padded = s.padStart(decimals, "0");
    formatted = `0.${padded}`;
  } else {
    const whole = s.slice(0, s.length - decimals);
    const frac = s.slice(s.length - decimals);
    formatted = `${whole}.${frac}`;
  }

  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Convert a human-readable decimal string to bigint base units.
 * Rejects values with more fractional digits than decimals.
 * e.g. fromDecimal("1.2345678", 7) => 12345678n
 * fromDecimal("1.23456789", 7) => throws validation error
 */
export function fromDecimal(str: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error("Decimals must be a non-negative integer");
  }

  if (typeof str !== "string" || !str.trim()) {
    throw new Error("Invalid decimal string");
  }

  const trimmed = str.trim();
  const isNegative = trimmed.startsWith("-");
  const value = isNegative ? trimmed.slice(1) : trimmed;

  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal number format: "${str}"`);
  }

  const [whole, frac = ""] = value.split(".");

  if (frac.length > decimals) {
    throw new Error(
      `Fractional part "${frac}" exceeds maximum allowed decimals of ${decimals}`,
    );
  }

  const paddedFrac = frac.padEnd(decimals, "0");
  const combined = `${whole}${paddedFrac}`;
  const result = BigInt(combined);

  return isNegative ? -result : result;
}
