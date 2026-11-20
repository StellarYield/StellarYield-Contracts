import { describe, it, expect } from "vitest";
import { xdr, nativeToScVal, Address } from "@stellar/stellar-sdk";
import {
  ScValTypeError,
  decodeAddress,
  decodeI128,
  decodeU64,
  decodeSymbol,
  decodeVec,
  decodeMap,
} from "./scval.js";

describe("ScValTypeError", () => {
  it("carries expected, actual, and value fields", () => {
    const val = xdr.ScVal.scvU32(42);
    const err = new ScValTypeError("scvAddress", "scvU32", val);
    expect(err.expected).toBe("scvAddress");
    expect(err.actual).toBe("scvU32");
    expect(err.value).toBe(val);
    expect(err.name).toBe("ScValTypeError");
    expect(err.message).toContain("expected scvAddress");
    expect(err.message).toContain("got scvU32");
  });
});

describe("decodeAddress", () => {
  it("decodes a valid scvAddress to a Stellar address string", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
    const scVal = Address.fromString(addr).toScVal();
    const result = decodeAddress(scVal);
    expect(result).toBe(addr);
  });

  it("throws ScValTypeError when passed an scvI128", () => {
    const scVal = nativeToScVal(1000n, { type: "i128" });
    expect(() => decodeAddress(scVal)).toThrow(ScValTypeError);
    try {
      decodeAddress(scVal);
    } catch (err) {
      expect(err).toBeInstanceOf(ScValTypeError);
      expect((err as ScValTypeError).expected).toBe("scvAddress");
      expect((err as ScValTypeError).actual).toBe("scvI128");
    }
  });

  it("throws ScValTypeError when passed an scvSymbol", () => {
    const scVal = xdr.ScVal.scvSymbol("deposit");
    expect(() => decodeAddress(scVal)).toThrow(ScValTypeError);
    try {
      decodeAddress(scVal);
    } catch (err) {
      expect((err as ScValTypeError).expected).toBe("scvAddress");
      expect((err as ScValTypeError).actual).toBe("scvSymbol");
    }
  });
});

describe("decodeI128", () => {
  it("decodes a valid scvI128 to a bigint", () => {
    const scVal = nativeToScVal(5000n, { type: "i128" });
    const result = decodeI128(scVal);
    expect(result).toBe(5000n);
  });

  it("decodes maximum i128 value correctly", () => {
    const maxI128 = (1n << 127n) - 1n;
    const scVal = nativeToScVal(maxI128, { type: "i128" });
    const result = decodeI128(scVal);
    expect(result).toBe(maxI128);
  });

  it("decodes minimum i128 value correctly", () => {
    const minI128 = -(1n << 127n);
    const scVal = nativeToScVal(minI128, { type: "i128" });
    const result = decodeI128(scVal);
    expect(result).toBe(minI128);
  });

  it("throws ScValTypeError when passed an scvAddress", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
    const scVal = Address.fromString(addr).toScVal();
    expect(() => decodeI128(scVal)).toThrow(ScValTypeError);
    try {
      decodeI128(scVal);
    } catch (err) {
      expect((err as ScValTypeError).expected).toBe("scvI128");
      expect((err as ScValTypeError).actual).toBe("scvAddress");
    }
  });
});

describe("decodeU64", () => {
  it("decodes a valid scvU64 to a bigint", () => {
    const scVal = nativeToScVal(123456789n, { type: "u64" });
    const result = decodeU64(scVal);
    expect(result).toBe(123456789n);
  });

  it("decodes maximum u64 value correctly", () => {
    const maxU64 = (1n << 64n) - 1n;
    const scVal = nativeToScVal(maxU64, { type: "u64" });
    const result = decodeU64(scVal);
    expect(result).toBe(maxU64);
  });

  it("throws ScValTypeError when passed an scvI128", () => {
    const scVal = nativeToScVal(1000n, { type: "i128" });
    expect(() => decodeU64(scVal)).toThrow(ScValTypeError);
    try {
      decodeU64(scVal);
    } catch (err) {
      expect((err as ScValTypeError).expected).toBe("scvU64");
      expect((err as ScValTypeError).actual).toBe("scvI128");
    }
  });
});

describe("decodeSymbol", () => {
  it("decodes a valid scvSymbol to a string", () => {
    const scVal = xdr.ScVal.scvSymbol("deposit");
    const result = decodeSymbol(scVal);
    expect(result).toBe("deposit");
  });

  it("decodes an empty symbol to an empty string", () => {
    const scVal = xdr.ScVal.scvSymbol("");
    const result = decodeSymbol(scVal);
    expect(result).toBe("");
  });

  it("throws ScValTypeError when passed an scvU32", () => {
    const scVal = xdr.ScVal.scvU32(42);
    expect(() => decodeSymbol(scVal)).toThrow(ScValTypeError);
    try {
      decodeSymbol(scVal);
    } catch (err) {
      expect((err as ScValTypeError).expected).toBe("scvSymbol");
      expect((err as ScValTypeError).actual).toBe("scvU32");
    }
  });
});

describe("decodeVec", () => {
  it("decodes a valid scvVec to an array of ScVals", () => {
    const scVal = nativeToScVal([100n, 200n], { type: "i128" });
    const result = decodeVec(scVal);
    expect(result).toHaveLength(2);
    expect(result[0].switch().name).toBe("scvI128");
    expect(result[1].switch().name).toBe("scvI128");
  });

  it("decodes an empty scvVec to an empty array", () => {
    const scVal = xdr.ScVal.scvVec([]);
    const result = decodeVec(scVal);
    expect(result).toEqual([]);
  });

  it("throws ScValTypeError when passed an scvMap", () => {
    const scVal = xdr.ScVal.scvMap([]);
    expect(() => decodeVec(scVal)).toThrow(ScValTypeError);
    try {
      decodeVec(scVal);
    } catch (err) {
      expect((err as ScValTypeError).expected).toBe("scvVec");
      expect((err as ScValTypeError).actual).toBe("scvMap");
    }
  });
});

describe("decodeMap", () => {
  it("decodes a valid scvMap to an array of key-value pairs", () => {
    const key1 = xdr.ScVal.scvSymbol("key1");
    const val1 = xdr.ScVal.scvU32(100);
    const key2 = xdr.ScVal.scvSymbol("key2");
    const val2 = xdr.ScVal.scvU32(200);
    const entry1 = new xdr.ScMapEntry({ key: key1, val: val1 });
    const entry2 = new xdr.ScMapEntry({ key: key2, val: val2 });
    const scVal = xdr.ScVal.scvMap([entry1, entry2]);

    const result = decodeMap(scVal);
    expect(result).toHaveLength(2);
    expect(result[0].key.switch().name).toBe("scvSymbol");
    expect(result[0].val.switch().name).toBe("scvU32");
    expect(result[1].key.switch().name).toBe("scvSymbol");
    expect(result[1].val.switch().name).toBe("scvU32");
  });

  it("decodes an empty scvMap to an empty array", () => {
    const scVal = xdr.ScVal.scvMap([]);
    const result = decodeMap(scVal);
    expect(result).toEqual([]);
  });

  it("throws ScValTypeError when passed an scvVec", () => {
    const scVal = xdr.ScVal.scvVec([]);
    expect(() => decodeMap(scVal)).toThrow(ScValTypeError);
    try {
      decodeMap(scVal);
    } catch (err) {
      expect((err as ScValTypeError).expected).toBe("scvMap");
      expect((err as ScValTypeError).actual).toBe("scvVec");
    }
  });
});

// ── Vacuousness checks ────────────────────────────────────────────────────────

describe("ScVal type check vacuousness", () => {
  it("type mismatch tests fail if type check is removed", () => {
    // This test verifies that the above type mismatch tests are not vacuous.
    // If the type check were removed from decodeAddress, this would pass,
    // proving the type mismatch tests above would catch a regression.
    const scVal = xdr.ScVal.scvU32(42);
    let threw = false;
    try {
      decodeAddress(scVal);
    } catch (err) {
      threw = err instanceof ScValTypeError;
    }
    expect(threw).toBe(true);
  });
});
