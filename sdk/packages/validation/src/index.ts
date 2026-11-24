/**
 * Zod schemas for the StellarYield backend API (Issue #867).
 *
 * These mirror the JSON the backend actually sends, so a frontend can validate
 * a response at runtime instead of trusting a cast:
 *
 *   const vault = VaultSchema.parse(await response.json());
 *
 * Three conventions are worth knowing:
 *
 * - **Token amounts are strings.** They are stroops and exceed
 *   `Number.MAX_SAFE_INTEGER`, so every amount is a digit string and is
 *   validated as one.
 * - **Dates are ISO-8601 strings.** The backend interfaces hold `Date` values,
 *   but `JSON.stringify` turns those into strings before they leave the
 *   process, which is what a validator on the client actually sees.
 * - **Stellar addresses are full base32.** The strkey alphabet is
 *   `A-Z2-7`, so `I`, `L` and `O` are legal — unlike bech32 or Crockford
 *   base32, which drop them.
 *
 * `src/drift.types.ts` asserts these stay in step with the backend's own
 * interfaces via `npm run typecheck`.
 */

import { z } from "zod";

/** A base-10 integer string, e.g. a stroop amount. */
const amountString = z
  .string()
  .regex(/^\d+$/, "expected a non-negative integer amount string");

/**
 * A Stellar strkey (account `G...` or contract `C...`), 56 characters.
 */
export const StellarAddressSchema = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, "expected a Stellar strkey address");

/**
 * An ISO-8601 date-time, as produced by `Date.prototype.toJSON`.
 *
 * Accepts an optional fractional part, because the backend serialises
 * `toISOString()` output such as `2026-01-15T00:00:00.000Z`, but rejects a
 * bare `2026-01-15` and any string `Date` cannot parse.
 */
const isoDate = z
  .string()
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
    "expected an ISO-8601 date-time",
  );

/** Lifecycle state of a vault. */
export const VaultStateSchema = z.enum([
  "Funding",
  "Active",
  "Matured",
  "Closed",
  "Cancelled",
]);

/**
 * A vault, mirroring the backend `Vault` interface.
 *
 * This is deliberately wider than the `Vault` schema in
 * `backend/api/openapi.json`, which omits `totalSharesEverMinted`,
 * `totalSharesEverBurned`, `minDeposit`, `maxDepositPerUser`, `zkmeVerifier`,
 * `rwaName`, `rwaSymbol`, `rwaDocumentUri`, `description` and `logoUri` even
 * though the API sends them. See the PR description.
 */
export const VaultSchema = z.object({
  id: z.number().int(),
  contractId: StellarAddressSchema,
  factoryId: StellarAddressSchema.nullable(),
  asset: StellarAddressSchema,
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  state: VaultStateSchema,
  totalAssets: amountString,
  totalSupply: amountString,
  totalSharesEverMinted: amountString,
  totalSharesEverBurned: amountString,
  depositorCount: z.number().int().nonnegative(),
  fundingTarget: amountString.nullable(),
  fundingDeadline: isoDate.nullable(),
  fundingProgress: z.number().min(0).max(100).nullable(),
  minDeposit: amountString.nullable(),
  maxDepositPerUser: amountString.nullable(),
  zkmeVerifier: StellarAddressSchema.nullable(),
  rwaName: z.string().nullable(),
  rwaSymbol: z.string().nullable(),
  rwaDocumentUri: z.string().nullable(),
  rwaCategory: z.string().nullable(),
  description: z.string().nullable(),
  logoUri: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  lastIndexedLedger: z.number().int().nullable(),
  lastIndexedAt: isoDate.nullable(),
  decimalsMismatch: z.boolean(),
});

/** A single yield-distribution epoch for a vault. */
export const EpochSchema = z.object({
  id: z.number().int(),
  vaultId: z.number().int(),
  /** Monotonic per-vault epoch counter, starting at 0. */
  epoch: z.number().int().nonnegative(),
  yieldAmount: amountString,
  totalShares: amountString,
  distributedAt: isoDate.nullable(),
  /** Yield after fees. */
  netYield: amountString,
});

/** A platform user. */
export const UserSchema = z.object({
  id: z.number().int(),
  /** Stellar account address of the user. */
  address: StellarAddressSchema,
  kycVerified: z.boolean(),
  amlFlagged: z.boolean(),
  amlFlaggedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

/** A user's position in a vault. */
export const PositionSchema = z.object({
  id: z.number().int(),
  userAddress: StellarAddressSchema,
  vaultId: z.number().int(),
  /** Present once the vault has a deployed contract. */
  contractId: StellarAddressSchema.optional(),
  state: VaultStateSchema.optional(),
  shares: amountString,
  deposited: amountString,
  lastClaimedEpoch: z.number().int().nonnegative(),
  updatedAt: isoDate,
});

/**
 * A user's aggregate portfolio.
 *
 * Mirrors the backend `UserPortfolioResponse` interface.
 */
export const UserPortfolioSchema = z.object({
  positions: z.array(PositionSchema),
  totalDeposited: amountString,
  totalPendingYield: amountString,
  totalValue: amountString,
});

/**
 * A page of results.
 *
 * `nextCursor` is optional because it only appears when there is a next page;
 * dropping it from a client is silent, so `drift.types.ts` checks it
 * explicitly.
 */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    nextCursor: z.string().nullable().optional(),
  });
}

/** A page of vaults. */
export const VaultListSchema = paginatedSchema(VaultSchema);

/**
 * The error codes the backend can emit, mirroring the `ErrorCode` enum in
 * `backend/src/api/middleware/errors.ts`.
 *
 * Kept in step by `drift.types.ts`.
 */
export const ErrorCodeSchema = z.enum([
  "VAULT_NOT_FOUND",
  "USER_NOT_FOUND",
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "RPC_ERROR",
  "INTERNAL_SERVER_ERROR",
  "NOT_FOUND",
  "WEBHOOK_INVALID",
  "QUERY_TIMEOUT",
]);

/**
 * The body sent for an `AppError`: a known failure with an `ErrorCode`.
 *
 * Mirrors the first branch of the handler in
 * `backend/src/api/middleware/errors.ts`, which sends no `error` key.
 */
export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  statusCode: z.number().int(),
});

/**
 * The body sent for anything that is not an `AppError`.
 *
 * Mirrors the fallback branch of the handler, which adds `error` (the JS error
 * name) alongside the code.
 */
export const InternalErrorSchema = AppErrorSchema.extend({
  error: z.string(),
});

/**
 * An error body returned for 4xx and 5xx responses.
 *
 * A union, because the backend's handler sends one of two shapes depending on
 * whether the throw was an `AppError`. Note that `backend/api/openapi.json`
 * documents only `{ error, message }`; no code path emits that, so this schema
 * follows the handler instead. See the PR description.
 */
export const ErrorSchema = z.union([AppErrorSchema, InternalErrorSchema]);

/** Response body of `GET /api/v1/health`. */
export const HealthSchema = z.object({
  version: z.string(),
  status: z.string(),
});

export type Vault = z.infer<typeof VaultSchema>;
export type Epoch = z.infer<typeof EpochSchema>;
export type User = z.infer<typeof UserSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type UserPortfolio = z.infer<typeof UserPortfolioSchema>;
export type VaultList = z.infer<typeof VaultListSchema>;
export type VaultState = z.infer<typeof VaultStateSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorBody = z.infer<typeof ErrorSchema>;
export type Health = z.infer<typeof HealthSchema>;

export { z };
