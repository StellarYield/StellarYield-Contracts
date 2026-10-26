import { describe, it, expect } from "vitest";
import { parseWindow, windowSchema, WindowError } from "./parseWindow.js";

describe("parseWindow (#1187)", () => {
  it("resolves P7D to 604800000 ms", () => {
    expect(parseWindow("P7D")).toBe(604_800_000);
  });

  it("resolves 7d to 604800000 ms", () => {
    expect(parseWindow("7d")).toBe(604_800_000);
  });

  it("resolves PT12H and 12h to the same value", () => {
    expect(parseWindow("PT12H")).toBe(parseWindow("12h"));
    expect(parseWindow("12h")).toBe(12 * 3_600_000);
  });

  it("resolves shorthand minutes and ISO weeks", () => {
    expect(parseWindow("30m")).toBe(30 * 60_000);
    expect(parseWindow("P2W")).toBe(2 * 604_800_000);
  });

  it("rejects P400D as exceeding 366 days", () => {
    expect(() => parseWindow("P400D")).toThrow(WindowError);
    expect(() => parseWindow("P400D")).toThrow(/366 days/);
  });

  it("rejects shorthand windows beyond 366 days", () => {
    expect(() => parseWindow("367d")).toThrow(/366 days/);
  });

  it("accepts exactly 366 days", () => {
    expect(parseWindow("P366D")).toBe(366 * 86_400_000);
  });

  it("rejects empty and malformed input", () => {
    expect(() => parseWindow("")).toThrow(WindowError);
    expect(() => parseWindow("not-a-window")).toThrow(WindowError);
    expect(() => parseWindow("P0D")).toThrow(WindowError);
    expect(() => parseWindow("-7d")).toThrow(WindowError);
  });

  it("windowSchema returns milliseconds for valid input", () => {
    const result = windowSchema.safeParse("P7D");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(604_800_000);
  });

  it("windowSchema fails with INVALID_WINDOW for P400D", () => {
    const result = windowSchema.safeParse("P400D");
    expect(result.success).toBe(false);
  });
});
