import { describe, it, expect } from "vitest";
import { VAULT_ERRORS, FACTORY_ERRORS, describeContractError } from "./errors.js";

describe("contract errors", () => {
  it("maps error codes to descriptions", () => {
    expect(describeContractError(1)).toBe(
      "This address has not passed KYC for the vault's zkMe verifier.",
    );
    expect(describeContractError(11)).toBe("The vault is paused.");
    expect(describeContractError(9999)).toBeUndefined();
  });

  it("contains all variants for vault and factory", () => {
    expect(VAULT_ERRORS[1].variant).toBe("NotKYCVerified");
    expect(FACTORY_ERRORS[1].variant).toBe("VaultAlreadyExists");
  });
});
