import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type {
  BatchVaultParams,
  InitParams,
  SingleRwaVaultInitParams,
} from "./types.js";

/** Soroban `String` / string-like args in the contracts. */
export function scString(s: string): xdr.ScVal {
  return nativeToScVal(s);
}

/** Encode `InitParams` for `__constructor` (single RWA vault deploy). */
export function encodeInitParams(p: InitParams): xdr.ScVal {
  return nativeToScVal({
    asset: Address.fromString(p.asset),
    share_name: p.share_name,
    share_symbol: p.share_symbol,
    share_decimals: p.share_decimals,
    admin: Address.fromString(p.admin),
    zkme_verifier: Address.fromString(p.zkme_verifier),
    cooperator: Address.fromString(p.cooperator),
    funding_target: p.funding_target,
    maturity_date: p.maturity_date,
    min_deposit: p.min_deposit,
    max_deposit_per_user: p.max_deposit_per_user,
    early_redemption_fee_bps: p.early_redemption_fee_bps,
    funding_deadline: p.funding_deadline,
    rwa_name: p.rwa_name,
    rwa_symbol: p.rwa_symbol,
    rwa_document_uri: p.rwa_document_uri,
    rwa_category: p.rwa_category,
    expected_apy: p.expected_apy,
  });
}

/** Same layout as `InitParams` (factory deploy uses `SingleRwaVaultInitParams`). */
export function encodeSingleRwaVaultInitParams(
  p: SingleRwaVaultInitParams,
): xdr.ScVal {
  const ip: InitParams = {
    asset: p.asset,
    share_name: p.share_name,
    share_symbol: p.share_symbol,
    share_decimals: p.share_decimals,
    admin: p.admin,
    zkme_verifier: p.zkme_verifier,
    cooperator: p.cooperator,
    funding_target: p.funding_target,
    maturity_date: p.maturity_date,
    min_deposit: p.min_deposit,
    max_deposit_per_user: p.max_deposit_per_user,
    early_redemption_fee_bps: p.early_redemption_fee_bps,
    funding_deadline: p.funding_deadline,
    rwa_name: p.rwa_name,
    rwa_symbol: p.rwa_symbol,
    rwa_document_uri: p.rwa_document_uri,
    rwa_category: p.rwa_category,
    expected_apy: p.expected_apy,
  };
  return encodeInitParams(ip);
}

export function encodeBatchVaultParams(p: BatchVaultParams): xdr.ScVal {
  return nativeToScVal({
    asset: Address.fromString(p.asset),
    name: p.name,
    symbol: p.symbol,
    rwa_name: p.rwa_name,
    rwa_symbol: p.rwa_symbol,
    rwa_document_uri: p.rwa_document_uri,
    rwa_category: p.rwa_category,
    expected_apy: p.expected_apy,
    maturity_date: p.maturity_date,
    funding_deadline: p.funding_deadline,
    funding_target: p.funding_target,
    min_deposit: p.min_deposit,
    max_deposit_per_user: p.max_deposit_per_user,
    early_redemption_fee_bps: p.early_redemption_fee_bps,
  });
}

/** 32-byte WASM hash or similar (`BytesN<32>`). Pass 64-char hex (optional `0x`) or a `Uint8Array` of length 32. */
export function encodeBytes32(hash: string | Uint8Array): xdr.ScVal {
  const buf = typeof hash === "string" ? hexToBytes32(hash) : hash;
  if (buf.length !== 32) {
    throw new Error(`Expected 32 bytes for BytesN<32>, got ${buf.length}`);
  }
  return nativeToScVal(buf, { type: "bytes" });
}

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64) {
    throw new Error(`Expected 64 hex chars for 32 bytes, got ${clean.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Address → `ScVal` for contract calls. */
export function scAddress(addr: string): xdr.ScVal {
  return Address.fromString(addr).toScVal();
}

/** `i128` values (amounts, shares). */
export function scI128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

export function scU32(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

export function scU64(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}
