import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatBps,
  formatDate,
  formatDuration,
  formatSharePrice,
  parseAmount,
  shortAddress,
} from "./format";

describe("formatAmount", () => {
  it("returns a placeholder for missing values", () => {
    expect(formatAmount(undefined, 7)).toBe("—");
  });

  it("renders zero without a fractional part", () => {
    expect(formatAmount(0n, 7)).toBe("0");
    expect(formatAmount(0n, 7, { maxFractionDigits: 7 })).toBe("0");
  });

  it("renders whole amounts and integer-only assets", () => {
    expect(formatAmount(1_234n, 0)).toBe("1,234");
    expect(formatAmount(1_234_000_000n, 7, { maxFractionDigits: 0 })).toBe(
      "123",
    );
    expect(formatAmount(123_450_000_000n, 7, { maxFractionDigits: 0 })).toBe(
      "12,345",
    );
  });

  it("renders decimals, trims trailing zeros and truncates to the requested precision", () => {
    expect(formatAmount(1n, 3, { maxFractionDigits: 4 })).toBe("0.001");
    expect(formatAmount(1_200_000n, 6, { maxFractionDigits: 3 })).toBe("1.2");
    expect(formatAmount(199n, 2, { maxFractionDigits: 1 })).toBe("1.9");
    expect(formatAmount(-1n, 7, { maxFractionDigits: 7 })).toBe("-0.0000001");
    expect(formatAmount(-1_234_567n, 2)).toBe("-12,345.67");
  });

  it("handles very large i128-scale values without losing precision", () => {
    const maxI128 = 2n ** 127n - 1n;

    expect(formatAmount(maxI128, 7)).toBe(
      "17,014,118,346,046,923,173,168,730,371,588.41",
    );
    expect(formatAmount(maxI128, 7, { maxFractionDigits: 7 })).toBe(
      "17,014,118,346,046,923,173,168,730,371,588.4105727",
    );
  });
});

describe("parseAmount", () => {
  it("converts decimal strings to the smallest unit", () => {
    expect(parseAmount("1", 2)).toBe(100n);
    expect(parseAmount("0.5", 2)).toBe(50n);
    expect(parseAmount(".5", 2)).toBe(50n);
    expect(parseAmount("1.", 2)).toBe(100n);
    expect(parseAmount("1,234.56", 2)).toBe(123_456n);
    expect(parseAmount("1.0000001", 7)).toBe(10_000_001n);
  });

  it("round-trips a very large i128-scale amount", () => {
    const maxI128 = 2n ** 127n - 1n;

    expect(parseAmount("17014118346046923173168730371588.4105727", 7)).toBe(
      maxI128,
    );
  });

  it.each([
    ["", 2, "Enter an amount"],
    ["   ", 2, "Enter an amount"],
    ["abc", 2, "Amount must be a number"],
    ["-1", 2, "Amount must be a number"],
    ["1e3", 2, "Amount must be a number"],
    ["1.2.3", 2, "Amount must be a number"],
    ["1.234", 2, "At most 2 decimal places"],
    ["0", 2, "Amount must be greater than zero"],
    ["0.00", 2, "Amount must be greater than zero"],
    [".", 2, "Amount must be greater than zero"],
  ] as const)("rejects invalid input %j", (input, decimals, message) => {
    expect(() => parseAmount(input, decimals)).toThrow(message);
  });
});

describe("shortAddress", () => {
  it("leaves short addresses untouched", () => {
    expect(shortAddress("GABC")).toBe("GABC");
    expect(shortAddress("GABC…WXYZ")).toBe("GABC…WXYZ");
  });

  it("shortens long addresses with configurable lead and tail lengths", () => {
    const address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    expect(shortAddress(address)).toBe("GABC…4567");
    expect(shortAddress(address, 6, 6)).toBe("GABCDE…234567");
  });
});

describe("formatBps", () => {
  it("returns a placeholder for missing values", () => {
    expect(formatBps(undefined)).toBe("—");
  });

  it("renders basis points as percentages", () => {
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(250)).toBe("2.50%");
    expect(formatBps(1000)).toBe("10%");
    expect(formatBps(333)).toBe("3.33%");
  });
});

describe("formatDate", () => {
  it("returns a placeholder for missing and zero timestamps", () => {
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate(0n)).toBe("—");
  });

  it("formats Unix seconds as a localized date", () => {
    const timestamp = BigInt(Date.UTC(2027, 2, 12, 12) / 1000);

    expect(formatDate(timestamp)).toMatch(/^Mar \d{1,2}, 2027$/);
  });
});

describe("formatDuration", () => {
  it("returns a placeholder for missing values and marks maturity at zero", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(0n)).toBe("Matured");
  });

  it("formats minutes, hours and days with correct pluralization", () => {
    expect(formatDuration(1n)).toBe("1 min");
    expect(formatDuration(120n)).toBe("2 mins");
    expect(formatDuration(3_600n)).toBe("1 hour");
    expect(formatDuration(7_200n)).toBe("2 hours");
    expect(formatDuration(86_400n)).toBe("1 day");
    expect(formatDuration(172_800n)).toBe("2 days");
  });
});

describe("formatSharePrice", () => {
  it("returns a placeholder for missing values", () => {
    expect(formatSharePrice(undefined, 6)).toBe("—");
  });

  it("renders scaled share prices with four decimal places", () => {
    expect(formatSharePrice(0n, 6)).toBe("0.0000");
    expect(formatSharePrice(1_035_000n, 6)).toBe("1.0350");
    expect(formatSharePrice(1_000_000n, 6)).toBe("1.0000");
    expect(formatSharePrice(1n, 0)).toBe("1.0000");
  });

  it("handles very large scaled share prices", () => {
    expect(formatSharePrice(10n ** 24n, 18)).toBe("1000000.0000");
  });
});
