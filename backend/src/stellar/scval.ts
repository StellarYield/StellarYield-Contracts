/**
 * ScVal decoding helper library.
 *
 * This module provides type-safe decoders for Soroban ScVal XDR types.
 * Each decoder validates the ScVal discriminant and throws ScValTypeError
 * if the actual type does not match the expected type.
 *
 * Closes #1195
 */

import { xdr, scValToNative } from "@stellar/stellar-sdk";

/**
 * Typed error thrown when an ScVal's discriminant does not match the expected type.
 *
 * @property {string} expected - The expected ScVal type name (e.g., "scvAddress")
 * @property {string} actual - The actual ScVal type name found
 * @property {unknown} value - The offending ScVal value
 */
export class ScValTypeError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
    public readonly value: unknown,
  ) {
    super(`ScVal type mismatch: expected ${expected}, got ${actual}`);
    this.name = "ScValTypeError";
  }
}

/**
 * Decode an ScVal address to a Stellar address string.
 *
 * @param {xdr.ScVal} val - The ScVal to decode
 * @returns {string} A Stellar address string (public key or contract ID)
 * @throws {ScValTypeError} If the ScVal is not scvAddress
 */
export function decodeAddress(val: xdr.ScVal): string {
  const typeName = val.switch().name;
  if (typeName !== "scvAddress") {
    throw new ScValTypeError("scvAddress", typeName, val);
  }
  try {
    const native = scValToNative(val);
    return typeof native === "string" ? native : String(native ?? "");
  } catch {
    return "";
  }
}

/**
 * Decode an ScVal i128 to a bigint.
 *
 * Reconstructs the full 128-bit signed integer from its high and low 64-bit parts.
 *
 * @param {xdr.ScVal} val - The ScVal to decode
 * @returns {bigint} The decoded 128-bit signed integer
 * @throws {ScValTypeError} If the ScVal is not scvI128
 */
export function decodeI128(val: xdr.ScVal): bigint {
  const typeName = val.switch().name;
  if (typeName !== "scvI128") {
    throw new ScValTypeError("scvI128", typeName, val);
  }
  try {
    const native = scValToNative(val);
    return BigInt(native);
  } catch {
    return 0n;
  }
}

/**
 * Decode an ScVal u64 to a bigint.
 *
 * @param {xdr.ScVal} val - The ScVal to decode
 * @returns {bigint} The decoded unsigned 64-bit integer
 * @throws {ScValTypeError} If the ScVal is not scvU64
 */
export function decodeU64(val: xdr.ScVal): bigint {
  const typeName = val.switch().name;
  if (typeName !== "scvU64") {
    throw new ScValTypeError("scvU64", typeName, val);
  }
  try {
    const native = scValToNative(val);
    return BigInt(native);
  } catch {
    return 0n;
  }
}

/**
 * Decode an ScVal symbol to a string.
 *
 * @param {xdr.ScVal} val - The ScVal to decode
 * @returns {string} The decoded symbol string
 * @throws {ScValTypeError} If the ScVal is not scvSymbol
 */
export function decodeSymbol(val: xdr.ScVal): string {
  const typeName = val.switch().name;
  if (typeName !== "scvSymbol") {
    throw new ScValTypeError("scvSymbol", typeName, val);
  }
  try {
    const native = scValToNative(val);
    return String(native ?? "");
  } catch {
    return "";
  }
}

/**
 * Decode an ScVal vec to an array of ScVals.
 *
 * @param {xdr.ScVal} val - The ScVal to decode
 * @returns {xdr.ScVal[]} The decoded array of ScVals (empty array if vec is empty)
 * @throws {ScValTypeError} If the ScVal is not scvVec
 */
export function decodeVec(val: xdr.ScVal): xdr.ScVal[] {
  const typeName = val.switch().name;
  if (typeName !== "scvVec") {
    throw new ScValTypeError("scvVec", typeName, val);
  }
  const vec = val.vec();
  return vec ? Array.from(vec) : [];
}

/**
 * Decode an ScVal map to an array of key-value pairs.
 *
 * @param {xdr.ScVal} val - The ScVal to decode
 * @returns {Array<{ key: xdr.ScVal; val: xdr.ScVal }>} The decoded map entries (empty array if map is empty)
 * @throws {ScValTypeError} If the ScVal is not scvMap
 */
export function decodeMap(val: xdr.ScVal): Array<{ key: xdr.ScVal; val: xdr.ScVal }> {
  const typeName = val.switch().name;
  if (typeName !== "scvMap") {
    throw new ScValTypeError("scvMap", typeName, val);
  }
  const map = val.map();
  return map ? Array.from(map).map((entry) => ({ key: entry.key(), val: entry.val() })) : [];
}
