import { describe, it, expect } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { matchTopic } from "./topicMatcher.js";

function makeEvent(topicValues: unknown[]): any {
  return {
    topic: topicValues.map((v) => nativeToScVal(v)),
  };
}

describe("matchTopic", () => {
  it("returns true for an exact match", () => {
    const event = makeEvent(["vault", "deposit"]);
    expect(matchTopic(event, ["vault", "deposit"])).toBe(true);
  });

  it("returns true with a wildcard in the pattern", () => {
    const event = makeEvent(["vault", "deposit"]);
    expect(matchTopic(event, ["vault", "*"])).toBe(true);
  });

  it("returns true with all wildcards", () => {
    const event = makeEvent(["vault", "deposit"]);
    expect(matchTopic(event, ["*", "*"])).toBe(true);
  });

  it("returns false when pattern length is shorter", () => {
    const event = makeEvent(["vault", "deposit"]);
    expect(matchTopic(event, ["vault"])).toBe(false);
  });

  it("returns false when pattern length is longer", () => {
    const event = makeEvent(["vault"]);
    expect(matchTopic(event, ["vault", "deposit"])).toBe(false);
  });

  it("returns false when topics do not match", () => {
    const event = makeEvent(["vault", "deposit"]);
    expect(matchTopic(event, ["vault", "withdraw"])).toBe(false);
  });

  it("returns true when wildcard matches any value", () => {
    const event = makeEvent(["vault", "withdraw"]);
    expect(matchTopic(event, ["vault", "*"])).toBe(true);
  });

  it("returns true with wildcard in first position", () => {
    const event = makeEvent(["factory", "deploy"]);
    expect(matchTopic(event, ["*", "deploy"])).toBe(true);
  });

  it("returns false with wildcard pattern but wrong length", () => {
    const event = makeEvent(["vault", "deposit", "user"]);
    expect(matchTopic(event, ["*", "*"])).toBe(false);
  });

  it("returns false for malformed event (no topics)", () => {
    expect(matchTopic({}, ["vault", "deposit"])).toBe(false);
  });

  it("returns false for null event", () => {
    expect(matchTopic(null, ["vault", "deposit"])).toBe(false);
  });

  it("handles three-topic event with exact match", () => {
    const event = makeEvent(["vault", "deposit", "user123"]);
    expect(matchTopic(event, ["vault", "deposit", "user123"])).toBe(true);
  });

  it("handles three-topic event with wildcard in middle", () => {
    const event = makeEvent(["vault", "deposit", "user123"]);
    expect(matchTopic(event, ["vault", "*", "user123"])).toBe(true);
  });

  it("returns false for three-topic event with wrong middle value", () => {
    const event = makeEvent(["vault", "deposit", "user123"]);
    expect(matchTopic(event, ["vault", "withdraw", "user123"])).toBe(false);
  });
});
