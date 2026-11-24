import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  AppErrorSchema,
  EpochSchema,
  ErrorCodeSchema,
  ErrorSchema,
  HealthSchema,
  InternalErrorSchema,
  PositionSchema,
  UserPortfolioSchema,
  UserSchema,
  VaultListSchema,
  VaultSchema,
} from "./index.js";

const CONTRACT = "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557";
const ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VERIFIER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** A complete vault, with every field the backend interface declares. */
const validVault = {
  id: 1,
  contractId: CONTRACT,
  factoryId: null,
  asset: ACCOUNT,
  name: "Treasury Bill Vault",
  symbol: "sTBill",
  state: "Active",
  totalAssets: "1000000000000",
  totalSupply: "950000000000",
  totalSharesEverMinted: "960000000000",
  totalSharesEverBurned: "10000000000",
  depositorCount: 42,
  fundingTarget: "5000000000000",
  fundingDeadline: "2026-12-31T00:00:00.000Z",
  fundingProgress: 20.5,
  minDeposit: "1000000",
  maxDepositPerUser: "250000000",
  zkmeVerifier: null,
  rwaName: "US Treasury Bill Fund",
  rwaSymbol: "sTBill",
  rwaDocumentUri: "https://example.com/prospectus.pdf",
  rwaCategory: "Government Debt",
  description: "Short-dated treasury bills",
  logoUri: "https://example.com/logo.png",
  createdAt: "2026-01-15T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  lastIndexedLedger: 12345678,
  lastIndexedAt: "2026-09-20T00:00:00.000Z",
  decimalsMismatch: false,
} as const;

describe("@stellaryield/validation", () => {
  it("parses a valid vault response", () => {
    const vault = VaultSchema.parse(validVault);
    expect(vault.contractId).toBe(CONTRACT);
    expect(vault.totalAssets).toBe("1000000000000");
  });

  it("throws a ZodError for an object that is not a vault", () => {
    expect(() => VaultSchema.parse({ invalid: true })).toThrow(ZodError);
  });

  it("keeps every declared field, so validating does not silently drop data", () => {
    // Zod strips unknown keys. A schema missing a field would parse happily
    // and then delete that field from the result, which is invisible unless
    // something checks the key set.
    expect(Object.keys(VaultSchema.parse(validVault)).sort()).toEqual(
      Object.keys(validVault).sort(),
    );
  });

  it("rejects a numeric amount, since token amounts overflow as JS numbers", () => {
    expect(() =>
      VaultSchema.parse({ ...validVault, totalAssets: 1_000_000_000_000 }),
    ).toThrow(ZodError);
  });

  it("rejects a decimal amount, because amounts are integer stroop counts", () => {
    expect(() => VaultSchema.parse({ ...validVault, totalAssets: "12.5" })).toThrow(ZodError);
  });

  it("rejects a malformed contract address", () => {
    expect(() => VaultSchema.parse({ ...validVault, contractId: "not-an-address" })).toThrow(
      ZodError,
    );
  });

  it("rejects an unknown vault state", () => {
    expect(() => VaultSchema.parse({ ...validVault, state: "Paused" })).toThrow(ZodError);
  });

  it("rejects a bare date, since the wire format is a full date-time", () => {
    expect(() =>
      VaultSchema.parse({ ...validVault, createdAt: "2026-01-15" }),
    ).toThrow(ZodError);
  });

  it("allows the nullable fields to be null", () => {
    const vault = VaultSchema.parse({
      ...validVault,
      factoryId: CONTRACT,
      fundingTarget: null,
      fundingDeadline: null,
      fundingProgress: null,
      zkmeVerifier: CONTRACT,
      logoUri: null,
    });
    expect(vault.fundingTarget).toBeNull();
    expect(vault.logoUri).toBeNull();
  });

  it("parses a valid epoch", () => {
    const epoch = EpochSchema.parse({
      id: 10,
      vaultId: 1,
      epoch: 4,
      yieldAmount: "5000000",
      totalShares: "950000000000",
      distributedAt: "2026-09-01T00:00:00.000Z",
      netYield: "4500000",
    });
    expect(epoch.epoch).toBe(4);
  });

  it("rejects an epoch with a negative counter", () => {
    expect(() =>
      EpochSchema.parse({
        id: 10,
        vaultId: 1,
        epoch: -1,
        yieldAmount: "1",
        totalShares: "1",
        distributedAt: null,
        netYield: "1",
      }),
    ).toThrow(ZodError);
  });

  it("parses a valid user", () => {
    const user = UserSchema.parse({
      id: 7,
      address: ACCOUNT,
      kycVerified: true,
      amlFlagged: false,
      amlFlaggedAt: null,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(user.kycVerified).toBe(true);
  });

  it("rejects a user whose flags are not booleans", () => {
    expect(() =>
      UserSchema.parse({
        id: 7,
        address: ACCOUNT,
        kycVerified: "yes",
        amlFlagged: false,
        amlFlaggedAt: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toThrow(ZodError);
  });

  it("parses a valid position and tolerates the optional fields being absent", () => {
    const position = PositionSchema.parse({
      id: 3,
      userAddress: ACCOUNT,
      vaultId: 1,
      shares: "1000000",
      deposited: "1000000",
      lastClaimedEpoch: 2,
      updatedAt: "2026-09-10T00:00:00.000Z",
    });
    expect(position.contractId).toBeUndefined();
  });

  describe("paginated vault list", () => {
    const list = {
      data: [validVault],
      total: 1,
      page: 1,
      pageSize: 20,
    };

    it("parses a list without a cursor", () => {
      const parsed = VaultListSchema.parse(list);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.nextCursor).toBeUndefined();
    });

    it("keeps nextCursor when cursor pagination is in use", () => {
      const parsed = VaultListSchema.parse({ ...list, nextCursor: "eyJpZCI6MX0" });
      expect(parsed.nextCursor).toBe("eyJpZCI6MX0");
    });

    it("accepts an explicit null cursor, which the service sends on the last page", () => {
      expect(VaultListSchema.parse({ ...list, nextCursor: null }).nextCursor).toBeNull();
    });
  });

  describe("error bodies", () => {
    it("parses the AppError shape, which has no error key", () => {
      const parsed = AppErrorSchema.parse({
        code: "VAULT_NOT_FOUND",
        message: "Vault not found",
        statusCode: 404,
      });
      expect(parsed.code).toBe("VAULT_NOT_FOUND");
      expect(parsed).not.toHaveProperty("error");
    });

    it("parses the generic 5xx shape", () => {
      const parsed = InternalErrorSchema.parse({
        code: "INTERNAL_SERVER_ERROR",
        error: "TypeError",
        message: "An unexpected error occurred",
        statusCode: 500,
      });
      expect(parsed.error).toBe("TypeError");
    });

    it("accepts either shape through the union", () => {
      expect(() =>
        ErrorSchema.parse({ code: "NOT_FOUND", message: "nope", statusCode: 404 }),
      ).not.toThrow();
      expect(() =>
        ErrorSchema.parse({
          code: "INTERNAL_SERVER_ERROR",
          error: "TypeError",
          message: "boom",
          statusCode: 500,
        }),
      ).not.toThrow();
    });

    it("rejects the shape the OpenAPI spec documents but the handler never sends", () => {
      // `api/openapi.json` describes `{ error, message }`. No code path emits
      // that, so accepting it would mean a client trusts a shape the backend
      // does not produce.
      expect(() => ErrorSchema.parse({ error: "Not Found", message: "Vault not found" })).toThrow(
        ZodError,
      );
    });

    it("rejects an unknown error code", () => {
      expect(() => ErrorCodeSchema.parse("TEAPOT")).toThrow(ZodError);
    });
  });

  it("parses health and portfolio responses", () => {
    expect(HealthSchema.parse({ version: "0.1.0", status: "ok" }).status).toBe("ok");

    const portfolio = UserPortfolioSchema.parse({
      positions: [
        {
          id: 3,
          userAddress: ACCOUNT,
          vaultId: 1,
          shares: "1000000",
          deposited: "1000000",
          lastClaimedEpoch: 2,
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      ],
      totalDeposited: "1000000",
      totalPendingYield: "5000",
      totalValue: "1005000",
    });
    expect(portfolio.positions).toHaveLength(1);
  });
});
