import { z } from "zod";

/**
 * Vault schema mirroring the backend `GET /api/v1/vaults` response shape.
 * Used by the integration test to prove the live backend returns data the
 * generated SDK client can parse (Issue #874).
 */
export const VaultSchema = z.object({
  id: z.number(),
  contractId: z.string(),
  factoryId: z.string().nullable(),
  asset: z.string(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  state: z.enum(["Funding", "Active", "Matured", "Closed", "Cancelled"]),
  totalAssets: z.string(),
  totalSupply: z.string(),
  depositorCount: z.number(),
  fundingTarget: z.string().nullable(),
  fundingDeadline: z.string().nullable(),
  fundingProgress: z.number().nullable(),
  minDeposit: z.string().nullable().optional(),
  maxDepositPerUser: z.string().nullable().optional(),
  rwaName: z.string().nullable().optional(),
  rwaSymbol: z.string().nullable().optional(),
  rwaDocumentUri: z.string().nullable().optional(),
  rwaCategory: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  logoUri: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastIndexedLedger: z.number().nullable(),
  lastIndexedAt: z.string().nullable(),
  decimalsMismatch: z.boolean(),
});

export type Vault = z.infer<typeof VaultSchema>;

export const VaultListSchema = z.object({
  data: z.array(VaultSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export type VaultList = z.infer<typeof VaultListSchema>;

export const HealthSchema = z.object({
  version: z.string(),
  status: z.string(),
});

export type Health = z.infer<typeof HealthSchema>;
