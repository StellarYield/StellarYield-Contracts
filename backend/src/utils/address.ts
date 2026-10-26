import { StrKey } from "@stellar/stellar-sdk";

export type AddressType = "account" | "contract" | "muxed" | "invalid";

/**
 * Classify a Stellar address using StrKey decoding and checksum verification.
 * Returns:
 * - "account" for valid G... Ed25519 public keys
 * - "contract" for valid C... Contract addresses
 * - "muxed" for valid M... Med25519 muxed accounts
 * - "invalid" for anything else or bad checksums
 */
export function classifyAddress(addr: string): AddressType {
  if (typeof addr !== "string" || !addr) {
    return "invalid";
  }

  // Check account (G...)
  try {
    if (addr.startsWith("G") && addr.length === 56) {
      StrKey.decodeEd25519PublicKey(addr);
      return "account";
    }
  } catch {
    return "invalid";
  }

  // Check contract (C...)
  try {
    if (addr.startsWith("C") && addr.length === 56) {
      StrKey.decodeContract(addr);
      return "contract";
    }
  } catch {
    return "invalid";
  }

  // Check muxed (M...)
  try {
    if (addr.startsWith("M") && addr.length === 69) {
      StrKey.decodeMed25519PublicKey(addr);
      return "muxed";
    }
  } catch {
    return "invalid";
  }

  return "invalid";
}
