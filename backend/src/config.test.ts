import { describe, it, expect } from "vitest";
import { config } from "./config.js";

describe("config", () => {
  it("has a positive port number", () => {
    expect(config.port).toBeGreaterThan(0);
  });
});
