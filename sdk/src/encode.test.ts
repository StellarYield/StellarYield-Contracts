import { describe, it, expect } from "vitest";
import {
  encodeBytes32,
  encodeInitParams,
  encodeSingleRwaVaultInitParams,
  encodeBatchVaultParams,
  scString,
  scAddress,
  scI128,
  scU32,
  scU64,
} from "./encode.js";
import type { InitParams, BatchVaultParams } from "./types.js";

const VALID_ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

describe("encode helpers", () => {
  it("encodes valid 32-byte hex and rejects invalid length", () => {
    const validHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const scVal = encodeBytes32(validHex);
    expect(scVal).toBeDefined();

    const withPrefix = "0x" + validHex;
    expect(encodeBytes32(withPrefix)).toBeDefined();

    expect(() => encodeBytes32("1234")).toThrow(/Expected 64 hex chars/);
    expect(() => encodeBytes32(new Uint8Array(10))).toThrow(/Expected 32 bytes/);
  });

  it("encodes primitive scVals", () => {
    expect(scString("hello")).toBeDefined();
    expect(scAddress(VALID_ADDR)).toBeDefined();
    expect(scI128(1000n)).toBeDefined();
    expect(scU32(42)).toBeDefined();
    expect(scU64(100n)).toBeDefined();
  });

  it("encodes InitParams and SingleRwaVaultInitParams", () => {
    const params: InitParams = {
      asset: VALID_ADDR,
      share_name: "Yield Share",
      share_symbol: "YLD",
      share_decimals: 7,
      admin: VALID_ADDR,
      zkme_verifier: VALID_ADDR,
      cooperator: VALID_ADDR,
      funding_target: 1000000n,
      maturity_date: 1800000000n,
      min_deposit: 100n,
      max_deposit_per_user: 10000n,
      early_redemption_fee_bps: 100,
      funding_deadline: 1750000000n,
      rwa_name: "Real Estate Vault",
      rwa_symbol: "REV",
      rwa_document_uri: "ipfs://test",
      rwa_category: "RealEstate",
      expected_apy: 850,
    };

    const encoded = encodeInitParams(params);
    expect(encoded).toBeDefined();
    const singleEncoded = encodeSingleRwaVaultInitParams(params);
    expect(singleEncoded).toBeDefined();
  });

  it("encodes BatchVaultParams", () => {
    const params: BatchVaultParams = {
      asset: VALID_ADDR,
      name: "Batch Vault",
      symbol: "BV",
      rwa_name: "Bond Vault",
      rwa_symbol: "BND",
      rwa_document_uri: "ipfs://bond",
      rwa_category: "Bonds",
      expected_apy: 600,
      maturity_date: 1800000000n,
      funding_deadline: 1750000000n,
      funding_target: 5000000n,
      min_deposit: 500n,
      max_deposit_per_user: 50000n,
      early_redemption_fee_bps: 50,
    };
    const encoded = encodeBatchVaultParams(params);
    expect(encoded).toBeDefined();
  });
});
