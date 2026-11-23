import { describe, it, expect } from "vitest";
import { parseHumanizedEvents } from "./parse.js";
import type { HumanizedSorobanEvent } from "./parse.js";

// Fixtures are stored in the humanized shape that `humanizeEvents` returns for
// the StellarYield vault emitters in `single_rwa_vault/src/events.rs`
// (deposit, yield_clm, erq_done). i128 values are stored as decimal strings
// because JSON cannot carry bigint.
import depositFixture from "./__fixtures__/deposit.json" with { type: "json" };
import yieldClaimedFixture from "./__fixtures__/yield-claimed.json" with { type: "json" };
import earlyRedemptionProcessedFixture from "./__fixtures__/early-redemption-processed.json" with { type: "json" };

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3BMNOP";
const CALLER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const RECEIVER = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

const deposit = depositFixture as HumanizedSorobanEvent;
const yieldClaimed = yieldClaimedFixture as HumanizedSorobanEvent;
const earlyRedemptionProcessed = earlyRedemptionProcessedFixture as HumanizedSorobanEvent;

describe("parseHumanizedEvents fixtures", () => {
  it("parses a deposit event into a typed deposit object", () => {
    const [parsed] = parseHumanizedEvents([deposit]);
    expect(parsed).toEqual({
      kind: "deposit",
      contractId: CONTRACT_ID,
      caller: CALLER,
      receiver: RECEIVER,
      assets: 1_000_000_000n,
      shares: 990_000_000n,
    });
  });

  it("parses a yield claim event into a typed yield_claimed object", () => {
    const [parsed] = parseHumanizedEvents([yieldClaimed]);
    expect(parsed).toEqual({
      kind: "yield_claimed",
      contractId: CONTRACT_ID,
      user: CALLER,
      amount: 5_000_000n,
      epoch: 3,
    });
  });

  it("parses an early redemption processed event into a typed object", () => {
    const [parsed] = parseHumanizedEvents([earlyRedemptionProcessed]);
    expect(parsed).toEqual({
      kind: "early_redemption_processed",
      contractId: CONTRACT_ID,
      user: CALLER,
      requestId: 7,
      netAssets: 985_000_000n,
    });
  });

  it("keeps event order when parsing a mixed batch", () => {
    const parsed = parseHumanizedEvents([deposit, yieldClaimed, earlyRedemptionProcessed]);
    expect(parsed.map((ev) => ev.kind)).toEqual([
      "deposit",
      "yield_claimed",
      "early_redemption_processed",
    ]);
  });
});

describe("parseHumanizedEvents unknown events", () => {
  it("returns an unknown contract event without throwing", () => {
    const unknownEvent: HumanizedSorobanEvent = {
      type: "contract",
      contractId: CONTRACT_ID,
      topics: ["mystery_evt"],
      data: [1],
    };

    expect(() => parseHumanizedEvents([unknownEvent])).not.toThrow();

    expect(parseHumanizedEvents([unknownEvent])).toEqual([
      {
        kind: "unknown",
        contractId: CONTRACT_ID,
        topics: ["mystery_evt"],
        data: [1],
      },
    ]);
  });

  it("returns a non-contract (system) event as unknown without a contractId", () => {
    const systemEvent: HumanizedSorobanEvent = {
      type: "system",
      topics: ["fee"],
      data: null,
    };

    expect(parseHumanizedEvents([systemEvent])).toEqual([
      { kind: "unknown", topics: ["fee"], data: null },
    ]);
  });

  it("does not drop a known event that follows an unknown one", () => {
    const unknownEvent: HumanizedSorobanEvent = {
      type: "contract",
      contractId: CONTRACT_ID,
      topics: ["mystery_evt"],
      data: [1],
    };

    const parsed = parseHumanizedEvents([unknownEvent, yieldClaimed]);
    expect(parsed.map((ev) => ev.kind)).toEqual(["unknown", "yield_claimed"]);
  });
});
