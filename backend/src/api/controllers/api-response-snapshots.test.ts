import { vi, describe, it, expect, beforeEach } from "vitest";

// `new VaultService()` / `new YieldService()` / `new UserService()` are called at
// controller module load, so the fakes must exist before the imports below run.
// `vi.hoisted` lifts them above the hoisted `vi.mock` calls.
const fakes = vi.hoisted(() => ({
  vault: {
    getVault: vi.fn(),
    listVaults: vi.fn(),
  },
  yields: {
    getEpochDetail: vi.fn(),
    getEpochClaimStats: vi.fn(),
    getEpochHolderCount: vi.fn(),
    deriveEpochStatus: vi.fn(),
    calculateParticipationRate: vi.fn(),
  },
  user: {
    getUserPortfolio: vi.fn(),
  },
}));

vi.mock("../../services/vault.js", () => ({
  VaultService: vi.fn(() => fakes.vault),
  validateFilterTree: vi.fn(() => undefined),
  VAULT_FIELD_ALLOWLIST: [] as string[],
  pickVaultFields: vi.fn((vault: unknown) => vault),
}));
vi.mock("../../services/yield.js", () => ({
  YieldService: vi.fn(() => fakes.yields),
  InvalidEpochCursorError: class InvalidEpochCursorError extends Error {},
}));
vi.mock("../../services/user.js", () => ({
  UserService: vi.fn(() => fakes.user),
}));
vi.mock("../../services/notifications.js", () => ({
  NotificationService: vi.fn(() => ({ notify: vi.fn() })),
}));
vi.mock("../../services/stellar.js", () => ({
  readTotalAssets: vi.fn(),
  readVaultState: vi.fn(),
  readPaused: vi.fn(),
  readCooperator: vi.fn(),
  readCooperatorFeeBps: vi.fn(),
  readKycVerified: vi.fn(),
}));
vi.mock("../../services/userSingleton.js", () => ({ userServiceInstance: {} }));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));
vi.mock("../../db/index.js", () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { listVaults, getVault } from "./vaults.js";
import { getEpochDetail } from "./yields.js";
import { getUserPortfolio } from "./users.js";

const CONTRACT_ID = "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557";
const USER_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FIXED_DATE = new Date("2025-01-01T00:00:00.000Z");

/**
 * Collapse the fields that legitimately change between runs — timestamps and
 * numeric row ids — to placeholders so the snapshots pin the response *shape*.
 * A field that is added, removed, or renamed still shows up as a diff.
 */
function normalize(value: unknown, key = ""): unknown {
  if (value instanceof Date) return "<date>";
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalize(v, k);
    }
    return out;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return "<date>";
  if (typeof value === "number" && /id$/i.test(key)) return "<id>";
  return value;
}

function makeRes() {
  return {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
}

const noopNext = vi.fn();

function lastJson(res: ReturnType<typeof makeRes>): unknown {
  expect(res.json).toHaveBeenCalledTimes(1);
  return normalize(res.json.mock.calls[0][0]);
}

const vaultFixture = {
  id: 42,
  contractId: CONTRACT_ID,
  factoryId: "CBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
  asset: "native",
  name: "Seed Vault",
  symbol: "SEED",
  state: "Active",
  totalAssets: "1234567",
  totalSupply: "1000000",
  totalSharesEverMinted: "1000000",
  totalSharesEverBurned: "0",
  depositorCount: 3,
  fundingTarget: "500000",
  fundingDeadline: FIXED_DATE,
  fundingProgress: 0.25,
  minDeposit: "10",
  maxDepositPerUser: "100000",
  zkmeVerifier: null,
  rwaName: null,
  rwaSymbol: null,
  rwaDocumentUri: null,
  rwaCategory: null,
  description: "Deterministic seed vault for snapshot coverage",
  logoUri: null,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("API response snapshots (#1291)", () => {
  it("vault detail response shape is stable", async () => {
    fakes.vault.getVault.mockResolvedValue(vaultFixture);
    const res = makeRes();

    await getVault(
      { params: { contractId: CONTRACT_ID }, query: {}, headers: {} } as never,
      res as never,
      noopNext,
    );

    expect(lastJson(res)).toMatchSnapshot();
  });

  it("vault list response shape is stable", async () => {
    fakes.vault.listVaults.mockResolvedValue({
      data: [
        { ...vaultFixture, id: 1, state: "Funding" },
        { ...vaultFixture, id: 2, state: "Active" },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    const res = makeRes();

    await listVaults(
      { query: { page: 1, pageSize: 20 } } as never,
      res as never,
      noopNext,
    );

    expect(lastJson(res)).toMatchSnapshot();
  });

  it("epoch detail response shape is stable", async () => {
    fakes.yields.getEpochDetail.mockResolvedValue({
      epoch: 3,
      yieldAmount: "1000000",
      totalShares: "4000000",
      yieldPerShare: "0.25",
      netYield: "950000",
      distributedAt: "2025-01-01T00:00:00.000Z",
      totalClaimed: "400000",
      totalUnclaimed: "600000",
    });
    fakes.yields.getEpochClaimStats.mockResolvedValue({
      claimedAmount: "400000",
      uniqueClaimants: 3,
    });
    fakes.yields.getEpochHolderCount.mockResolvedValue(12);
    fakes.yields.deriveEpochStatus.mockReturnValue("partially_claimed");
    fakes.yields.calculateParticipationRate.mockReturnValue(0.25);
    const res = makeRes();

    await getEpochDetail(
      { params: { contractId: CONTRACT_ID, epoch: "3" } } as never,
      res as never,
      noopNext,
    );

    expect(lastJson(res)).toMatchSnapshot();
  });

  it("user portfolio response shape is stable", async () => {
    fakes.user.getUserPortfolio.mockResolvedValue({
      positions: [
        {
          id: 7,
          userAddress: USER_ADDRESS,
          vaultId: 42,
          contractId: CONTRACT_ID,
          state: "Active",
          shares: "250000",
          deposited: "250000",
          lastClaimedEpoch: 2,
          updatedAt: FIXED_DATE,
        },
      ],
      totalDeposited: "250000",
      totalPendingYield: "12500",
      totalValue: "262500",
    });
    const res = makeRes();

    await getUserPortfolio(
      { params: { address: USER_ADDRESS } } as never,
      res as never,
      noopNext,
    );

    expect(lastJson(res)).toMatchSnapshot();
  });
});
