import { describe, it, expect, vi } from "vitest";
import { signTransactionWithFreighter } from "./freighter.js";

vi.mock("@stellar/freighter-api", () => {
  return {
    signTransaction: vi.fn(),
  };
});

describe("freighter signing wrapper", () => {
  it("returns signed transaction XDR and signer address on success", async () => {
    const { signTransaction } = await import("@stellar/freighter-api");
    vi.mocked(signTransaction).mockResolvedValueOnce({
      signedTxXdr: "AAAA...",
      signerAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    } as any);

    const res = await signTransactionWithFreighter("AAAA...", {
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    expect(res.signedTxXdr).toBe("AAAA...");
    expect(res.signerAddress).toBe(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    );
  });

  it("throws when user declines or signs with error", async () => {
    const { signTransaction } = await import("@stellar/freighter-api");
    vi.mocked(signTransaction).mockResolvedValueOnce({
      error: "User declined transaction",
    } as any);

    await expect(signTransactionWithFreighter("AAAA...")).rejects.toThrow(
      "User declined transaction",
    );
  });

  it("throws when freighter extension is not installed or available", async () => {
    const { signTransaction } = await import("@stellar/freighter-api");
    vi.mocked(signTransaction).mockResolvedValueOnce({
      error: "Freighter is not installed",
    } as any);

    await expect(signTransactionWithFreighter("AAAA...")).rejects.toThrow(
      "Freighter is not installed",
    );
  });
});
