import { humanizeEvents } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";

/** Humanized contract event from `humanizeEvents`. */
export type HumanizedSorobanEvent = {
  type: "system" | "contract" | "diagnostic";
  contractId?: string;
  topics: unknown[];
  data: unknown;
};

/** Discriminated union for StellarYield vault + factory events we recognize. */
export type ParsedStellarYieldEvent =
  | {
      kind: "deposit";
      contractId: string;
      caller: string;
      receiver: string;
      assets: bigint;
      shares: bigint;
    }
  | {
      kind: "withdraw";
      contractId: string;
      caller: string;
      receiver: string;
      owner: string;
      assets: bigint;
      shares: bigint;
    }
  | {
      kind: "yield_distributed";
      contractId: string;
      epoch: number;
      amount: bigint;
      timestamp: bigint;
    }
  | {
      kind: "yield_claimed";
      contractId: string;
      user: string;
      amount: bigint;
      epoch: number;
    }
  | {
      kind: "vault_state_changed";
      contractId: string;
      oldState: string;
      newState: string;
    }
  | {
      kind: "redeem_at_maturity";
      contractId: string;
      owner: string;
      receiver: string;
      shares: bigint;
      assets: bigint;
      yieldClaimed: bigint;
    }
  | {
      kind: "early_redemption_requested";
      contractId: string;
      user: string;
      requestId: number;
      shares: bigint;
    }
  | {
      kind: "early_redemption_processed";
      contractId: string;
      user: string;
      requestId: number;
      netAssets: bigint;
    }
  | {
      kind: "early_redemption_cancelled";
      contractId: string;
      user: string;
      requestId: number;
      shares: bigint;
    }
  | {
      kind: "vault_created";
      contractId: string;
      vault: string;
      vaultType: string;
      name: string;
      creator: string;
    }
  | {
      kind: "vault_status_changed";
      contractId: string;
      vault: string;
      active: boolean;
    }
  | {
      kind: "vault_removed";
      contractId: string;
      vault: string;
      removedBy: string;
    }
  | {
      kind: "defaults_updated";
      contractId: string;
      asset: string;
      zkmeVerifier: string;
      cooperator: string;
    }
  | { kind: "unknown"; contractId?: string; topics: unknown[]; data: unknown };

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && /^-?[0-9]+$/.test(v)) return BigInt(v);
  return 0n;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Decode raw Soroban events (e.g. from transaction meta) into typed SDK objects.
 * Unknown shapes are returned as `{ kind: 'unknown', ... }`.
 */
export function parseVaultEvents(
  events: xdr.DiagnosticEvent[] | xdr.ContractEvent[],
): ParsedStellarYieldEvent[] {
  const human = humanizeEvents(events) as HumanizedSorobanEvent[];
  const out: ParsedStellarYieldEvent[] = [];
  for (const ev of human) {
    if (ev.type !== "contract" || !ev.contractId) {
      out.push({ kind: "unknown", topics: ev.topics, data: ev.data });
      continue;
    }
    const cid = ev.contractId;
    const topics = ev.topics;
    const data = ev.data;
    const tag = topics[0];

    // Topics: first is often the short symbol name (e.g. "deposit")
    if (tag === "deposit" && topics.length >= 3) {
      out.push({
        kind: "deposit",
        contractId: cid,
        caller: asStr(topics[1]),
        receiver: asStr(topics[2]),
        assets: asBigInt((data as unknown[])[0]),
        shares: asBigInt((data as unknown[])[1]),
      });
      continue;
    }
    if (tag === "withdraw" && topics.length >= 4) {
      const d = data as unknown[];
      out.push({
        kind: "withdraw",
        contractId: cid,
        caller: asStr(topics[1]),
        receiver: asStr(topics[2]),
        owner: asStr(topics[3]),
        assets: asBigInt(d[0]),
        shares: asBigInt(d[1]),
      });
      continue;
    }
    if (tag === "yield_dis") {
      const d = data as unknown[];
      out.push({
        kind: "yield_distributed",
        contractId: cid,
        epoch: Number(topics[1] ?? 0),
        amount: asBigInt(d[0]),
        timestamp: asBigInt(d[1]),
      });
      continue;
    }
    if (tag === "yield_clm" && topics.length >= 2) {
      const d = data as unknown[];
      out.push({
        kind: "yield_claimed",
        contractId: cid,
        user: asStr(topics[1]),
        amount: asBigInt(d[0]),
        epoch: Number(d[1] ?? 0),
      });
      continue;
    }
    if (tag === "st_chg") {
      const d = data as unknown[];
      out.push({
        kind: "vault_state_changed",
        contractId: cid,
        oldState: asStr(d[0]),
        newState: asStr(d[1]),
      });
      continue;
    }
    if (tag === "mat_redm" && topics.length >= 3) {
      const d = data as unknown[];
      out.push({
        kind: "redeem_at_maturity",
        contractId: cid,
        owner: asStr(topics[1]),
        receiver: asStr(topics[2]),
        shares: asBigInt(d[0]),
        assets: asBigInt(d[1]),
        yieldClaimed: asBigInt(d[2]),
      });
      continue;
    }
    if (tag === "erq_req" && topics.length >= 2) {
      const d = data as unknown[];
      out.push({
        kind: "early_redemption_requested",
        contractId: cid,
        user: asStr(topics[1]),
        requestId: Number(d[0] ?? 0),
        shares: asBigInt(d[1]),
      });
      continue;
    }
    if (tag === "erq_done" && topics.length >= 2) {
      const d = data as unknown[];
      out.push({
        kind: "early_redemption_processed",
        contractId: cid,
        user: asStr(topics[1]),
        requestId: Number(d[0] ?? 0),
        netAssets: asBigInt(d[1]),
      });
      continue;
    }
    if (tag === "erq_can" && topics.length >= 2) {
      const d = data as unknown[];
      out.push({
        kind: "early_redemption_cancelled",
        contractId: cid,
        user: asStr(topics[1]),
        requestId: Number(d[0] ?? 0),
        shares: asBigInt(d[1]),
      });
      continue;
    }
    if (tag === "v_create" && topics.length >= 2) {
      const d = data as unknown[];
      out.push({
        kind: "vault_created",
        contractId: cid,
        vault: asStr(topics[1]),
        vaultType: asStr(d[0]),
        name: asStr(d[1]),
        creator: asStr(d[2]),
      });
      continue;
    }
    if (tag === "v_status" && topics.length >= 2) {
      out.push({
        kind: "vault_status_changed",
        contractId: cid,
        vault: asStr(topics[1]),
        active: Boolean(data),
      });
      continue;
    }
    if (tag === "v_remove" && topics.length >= 2) {
      out.push({
        kind: "vault_removed",
        contractId: cid,
        vault: asStr(topics[1]),
        removedBy: asStr(data),
      });
      continue;
    }
    if (tag === "def_upd") {
      const d = data as unknown[];
      out.push({
        kind: "defaults_updated",
        contractId: cid,
        asset: asStr(d[0]),
        zkmeVerifier: asStr(d[1]),
        cooperator: asStr(d[2]),
      });
      continue;
    }

    out.push({ kind: "unknown", contractId: cid, topics, data });
  }
  return out;
}
