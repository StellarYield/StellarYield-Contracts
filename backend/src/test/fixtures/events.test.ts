import { describe, it, expect } from "vitest";
import {
  parseDepositEvent,
  parseWithdrawEvent,
  parseYieldDistributedEvent,
  parseVaultStateChangedEvent,
  parseVaultCreatedEvent,
  parseCancelFundingEvent,
  parseVaultRemovedEvent,
  parseOperatorAddedEvent,
  parseOperatorRemovedEvent,
  parseRoleGrantedEvent,
  parseRoleRevokedEvent,
  parseRequestEarlyRedemptionEvent,
  parseYieldClaimedEvent,
  parseYieldClaimedPartialEvent,
  parseEarlyRedemptionProcessedEvent,
  parseEarlyRedemptionCancelledEvent,
  parseZkmeVerifierUpdatedEvent,
  parseAdminTransferredEvent,
  parseDefaultsUpdatedEvent,
  parseKycSetEvent,
  parsePausedEvent,
  parseUnpausedEvent,
} from "../../services/indexer.js";
import {
  VAULT_CONTRACT,
  USER_ADDRESS,
  OTHER_ADDRESS,
  makeDepositEvent,
  makeWithdrawEvent,
  makeYieldDistributedEvent,
  makeVaultStateChangedEvent,
  makeVaultCreatedEvent,
  makeCancelFundingEvent,
  makeVaultRemovedEvent,
  makeOperatorAddedEvent,
  makeOperatorRemovedEvent,
  makeRoleGrantedEvent,
  makeRoleRevokedEvent,
  makeRequestEarlyRedemptionEvent,
  makeYieldClaimedEvent,
  makeYieldClaimedPartialEvent,
  makeEarlyRedemptionProcessedEvent,
  makeEarlyRedemptionCancelledEvent,
  makeZkmeVerifierUpdatedEvent,
  makeAdminTransferredEvent,
  makeDefaultsUpdatedEvent,
  makeKycSetEvent,
  makePausedEvent,
  makeUnpausedEvent,
} from "./events.js";

describe("event fixture factory (#697)", () => {
  it("makeDepositEvent parses to the expected fields", () => {
    const parsed = parseDepositEvent(makeDepositEvent({ assets: 5n, shares: 5n }));
    expect(parsed).toEqual({ caller: USER_ADDRESS, receiver: USER_ADDRESS, assets: 5n, shares: 5n });
  });

  it("makeWithdrawEvent parses to the expected fields", () => {
    const parsed = parseWithdrawEvent(makeWithdrawEvent());
    expect(parsed).not.toBeNull();
    expect(parsed?.assets).toBe(500n);
  });

  it("makeYieldDistributedEvent parses to the expected fields", () => {
    const parsed = parseYieldDistributedEvent(makeYieldDistributedEvent({ epoch: 3, amount: 42n }));
    expect(parsed).toEqual({ epoch: 3, amount: 42n, timestamp: 1_700_000_000n });
  });

  it("makeVaultStateChangedEvent parses to the expected fields", () => {
    const parsed = parseVaultStateChangedEvent(
      makeVaultStateChangedEvent({ oldState: "Active", newState: "Matured" }),
    );
    expect(parsed).toEqual({ oldState: "Active", newState: "Matured" });
  });

  it("makeVaultCreatedEvent is recognized by the parser", () => {
    const parsed = parseVaultCreatedEvent(makeVaultCreatedEvent({ name: "Test Vault" }));
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("Test Vault");
  });

  it("makeCancelFundingEvent is recognized by the parser", () => {
    const parsed = parseCancelFundingEvent(makeCancelFundingEvent({ contractId: VAULT_CONTRACT }));
    expect(parsed).toEqual({ contractId: VAULT_CONTRACT });
  });

  it("makeVaultRemovedEvent is recognized by the parser", () => {
    const parsed = parseVaultRemovedEvent(makeVaultRemovedEvent({ contractId: VAULT_CONTRACT }));
    expect(parsed).toEqual({ contractId: VAULT_CONTRACT });
  });

  it("makeOperatorAddedEvent parses to the expected fields", () => {
    const parsed = parseOperatorAddedEvent(makeOperatorAddedEvent());
    expect(parsed?.caller).toBe(USER_ADDRESS);
  });

  it("makeOperatorRemovedEvent parses to the expected fields", () => {
    const parsed = parseOperatorRemovedEvent(makeOperatorRemovedEvent({ reason: "policy" }));
    expect(parsed?.reason).toBe("policy");
  });

  it("makeRoleGrantedEvent parses to the expected fields", () => {
    const parsed = parseRoleGrantedEvent(makeRoleGrantedEvent({ role: "Admin" }));
    expect(parsed).toEqual({ userAddress: USER_ADDRESS, role: "Admin" });
  });

  it("makeRoleRevokedEvent parses to the expected fields", () => {
    const parsed = parseRoleRevokedEvent(makeRoleRevokedEvent({ role: "Admin" }));
    expect(parsed).toEqual({ userAddress: USER_ADDRESS, role: "Admin" });
  });

  it("makeRequestEarlyRedemptionEvent parses to the expected fields", () => {
    const parsed = parseRequestEarlyRedemptionEvent(makeRequestEarlyRedemptionEvent({ requestId: 7 }));
    expect(parsed?.requestId).toBe(7);
  });

  it("makeYieldClaimedEvent parses to the expected fields", () => {
    const parsed = parseYieldClaimedEvent(makeYieldClaimedEvent({ amount: 900n, epoch: 2 }));
    expect(parsed).toEqual({ user: USER_ADDRESS, amount: 900n, epoch: 2 });
  });

  it("makeYieldClaimedPartialEvent parses to the expected fields", () => {
    const parsed = parseYieldClaimedPartialEvent(
      makeYieldClaimedPartialEvent({ claimed: 100n, shortfall: 50n, epoch: 4 }),
    );
    expect(parsed).toEqual({ user: USER_ADDRESS, claimed: 100n, shortfall: 50n, epoch: 4 });
  });

  it("makeEarlyRedemptionProcessedEvent parses to the expected fields", () => {
    const parsed = parseEarlyRedemptionProcessedEvent(makeEarlyRedemptionProcessedEvent());
    expect(parsed?.user).toBe(USER_ADDRESS);
  });

  it("makeEarlyRedemptionCancelledEvent parses to the expected fields", () => {
    const parsed = parseEarlyRedemptionCancelledEvent(makeEarlyRedemptionCancelledEvent());
    expect(parsed?.user).toBe(USER_ADDRESS);
  });

  it("makeZkmeVerifierUpdatedEvent parses to the expected fields", () => {
    const parsed = parseZkmeVerifierUpdatedEvent(makeZkmeVerifierUpdatedEvent());
    expect(parsed?.caller).toBe(USER_ADDRESS);
  });

  it("makeAdminTransferredEvent parses to the expected fields", () => {
    const parsed = parseAdminTransferredEvent(
      makeAdminTransferredEvent({ oldAdmin: USER_ADDRESS, newAdmin: OTHER_ADDRESS }),
    );
    expect(parsed).toEqual({ oldAdmin: USER_ADDRESS, newAdmin: OTHER_ADDRESS });
  });

  it("makeDefaultsUpdatedEvent parses to the expected fields", () => {
    const parsed = parseDefaultsUpdatedEvent(
      makeDefaultsUpdatedEvent({ asset: "XLM", zkmeVerifier: USER_ADDRESS, cooperator: OTHER_ADDRESS }),
    );
    expect(parsed).toEqual({ asset: "XLM", zkmeVerifier: USER_ADDRESS, cooperator: OTHER_ADDRESS });
  });

  it("makeKycSetEvent parses to the expected fields", () => {
    const parsed = parseKycSetEvent(makeKycSetEvent({ verified: false }));
    expect(parsed).toEqual({ user: USER_ADDRESS, verified: false, timestamp: 1_700_000_000n });
  });

  it("makePausedEvent is recognized by the parser", () => {
    const parsed = parsePausedEvent(makePausedEvent({ contractId: VAULT_CONTRACT }));
    expect(parsed).toEqual({ contractId: VAULT_CONTRACT });
  });

  it("makeUnpausedEvent is recognized by the parser", () => {
    const parsed = parseUnpausedEvent(makeUnpausedEvent({ contractId: VAULT_CONTRACT }));
    expect(parsed).toEqual({ contractId: VAULT_CONTRACT });
  });
});
