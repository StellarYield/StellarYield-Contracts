import { describe, it, expect } from "vitest";
import {
  formatShares,
  calculateYieldApy,
  isVaultActive,
  isVaultRedeemable,
} from "./utils.js";

describe("utils helpers", () => {
  describe("formatShares", () => {
    it("formats shares with different decimals", () => {
      expect(formatShares(1230000000n, 7)).toBe("123");
      expect(formatShares(1234500000n, 7)).toBe("123.45");
      expect(formatShares(100n, 0)).toBe("100");
      expect(formatShares(1000000000000000000n, 18)).toBe("1");
    });

    it("throws for negative or excessive decimals", () => {
      expect(() => formatShares(100n, -1)).toThrow("decimals must be 0–18");
      expect(() => formatShares(100n, 19)).toThrow("decimals must be 0–18");
    });
  });

  describe("calculateYieldApy", () => {
    it("calculates annualized yield accurately", () => {
      const apy = calculateYieldApy(500n, 10000n, 31_536_000n);
      expect(apy).toBeCloseTo(0.05);
    });

    it("returns 0 for zero or negative principal or duration", () => {
      expect(calculateYieldApy(500n, 0n, 31_536_000n)).toBe(0);
      expect(calculateYieldApy(500n, 10000n, 0n)).toBe(0);
      expect(calculateYieldApy(500n, -100n, 31_536_000n)).toBe(0);
      expect(calculateYieldApy(500n, 10000n, -100n)).toBe(0);
    });
  });

  describe("isVaultActive", () => {
    it("returns true only for Funding and Active states", () => {
      expect(isVaultActive("Funding")).toBe(true);
      expect(isVaultActive("Active")).toBe(true);
      expect(isVaultActive("Matured")).toBe(false);
      expect(isVaultActive("Closed")).toBe(false);
      expect(isVaultActive("Cancelled")).toBe(false);
    });
  });

  describe("isVaultRedeemable", () => {
    it("returns true only for Active and Matured states", () => {
      expect(isVaultRedeemable("Active")).toBe(true);
      expect(isVaultRedeemable("Matured")).toBe(true);
      expect(isVaultRedeemable("Funding")).toBe(false);
      expect(isVaultRedeemable("Closed")).toBe(false);
      expect(isVaultRedeemable("Cancelled")).toBe(false);
    });
  });
});
