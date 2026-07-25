import { GraphQLError } from "graphql";
import { UserService } from "../services/user.js";
import { YieldService } from "../services/yield.js";
import { query } from "../db/index.js";
import type { GraphQLContext } from "./context.js";

const userService = new UserService();
const yieldService = new YieldService();

/** Throws when the resolved API key role does not grant access (#772). */
function requireRole(role: string, context: GraphQLContext): void {
  if (context?.role !== role) {
    throw new GraphQLError("Forbidden", { extensions: { code: "FORBIDDEN" } });
  }
}

function computeYieldPerShare(yieldAmount: string, totalShares: string): string {
  const yieldBig = BigInt(yieldAmount);
  const sharesBig = BigInt(totalShares);
  if (sharesBig === BigInt(0)) return "0";
  const DECIMALS = BigInt(10) ** BigInt(18);
  const result = (yieldBig * DECIMALS) / sharesBig;
  const padded = result.toString().padStart(19, "0");
  return `${padded.slice(0, -18)}.${padded.slice(-18)}`;
}

export const root = {
  user: async ({ address }: { address: string }) => {
    const user = await userService.getUser(address);
    if (!user) return null;
    return {
      address: user.address,
      kycVerified: user.kycVerified,
      createdAt: user.createdAt.toISOString(),
    };
  },
  epochs: async ({ contractId }: { contractId: string }) => {
    const epochs = await yieldService.getVaultEpochs(contractId);
    return epochs.map((e) => ({
      epoch: e.epoch,
      yieldAmount: e.yieldAmount,
      totalShares: e.totalShares,
      yieldPerShare: computeYieldPerShare(e.yieldAmount, e.totalShares),
      distributedAt: e.distributedAt ? e.distributedAt.toISOString() : null,
    }));
  },
  apiKeys: async (_args: unknown, context: GraphQLContext) => {
    requireRole("admin", context);
    const rows = await query<{ id: number; label: string | null; role: string; created_at: Date }>(
      "SELECT id, label, role, created_at FROM api_keys ORDER BY created_at DESC",
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      role: row.role,
      createdAt: row.created_at.toISOString(),
    }));
  },
};
