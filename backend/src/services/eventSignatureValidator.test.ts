import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { reconstructSignedLedgerEntry, verifyStellarEventSignature } from "./eventSignatureValidator.js";

describe("eventSignatureValidator (#1172)", () => {
  it("accepts an unsigned Stellar ledger event", () => {
    expect(verifyStellarEventSignature({
      ledger: 123,
      txHash: "tx123",
      contractId: "C" + "A".repeat(55),
      eventType: "deposit",
      payload: { amount: "100" },
    })).toBe(true);
  });

  it("rejects a signed payload without a valid signer key", () => {
    expect(verifyStellarEventSignature({
      ledger: 123,
      txHash: "tx123",
      contractId: "C" + "A".repeat(55),
      eventType: "deposit",
      payload: { amount: "100", signature: "bad" },
    })).toBe(false);
  });

  it("verifies an Ed25519 signature over the reconstructed ledger entry", () => {
    const keypair = Keypair.random();
    const event = {
      ledger: 123,
      txHash: "tx123",
      contractId: "C" + "A".repeat(55),
      eventType: "deposit",
      payload: { amount: "100", signer: keypair.publicKey() },
    };
    const signature = keypair.sign(reconstructSignedLedgerEntry({
      ...event,
      payload: event.payload,
    })).toString("base64");

    expect(verifyStellarEventSignature({
      ...event,
      payload: { ...event.payload, signature },
    })).toBe(true);
  });
});
