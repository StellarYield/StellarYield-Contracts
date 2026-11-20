// Replay harness for recorded Soroban `getEvents` responses (#1292).
//
// The fixtures under tests/fixtures/rpc/ hold the JSON a real RPC returns for a
// deposit, a yield distribution and a vault state change. `createReplayRpc`
// serves them back through the same `getEvents` / `getLatestLedger` surface the
// indexer calls, and `createFakeDb` stands in for Postgres so a replayed batch
// can be asserted row-by-row without a live database in CI.
import { readFileSync, readdirSync } from "node:fs";

export interface RawRpcEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  inSuccessfulContractCall: boolean;
  txHash: string;
  topic: string[];
  value: string;
}

export interface RpcFixture {
  latestLedger: number;
  events: RawRpcEvent[];
  cursor: string;
}

const FIXTURE_DIR = new URL("../../tests/fixtures/rpc/", import.meta.url);

export function loadRpcFixture(name: string): RpcFixture {
  const file = new URL(`${name}.json`, FIXTURE_DIR);
  return JSON.parse(readFileSync(file, "utf8")) as RpcFixture;
}

/** Load every recorded fixture, sorted by name for deterministic replay. */
export function loadAllRpcFixtures(): RpcFixture[] {
  const dir = new URL("./", FIXTURE_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as RpcFixture);
}

export interface ReplayRpc {
  getLatestLedger: () => Promise<{ sequence: number }>;
  getEvents: (args: {
    startLedger: number;
    filters?: Array<{ contractIds?: string[] }>;
  }) => Promise<{ events: RawRpcEvent[]; latestLedger: number }>;
  /** Number of getEvents calls served so far. */
  callCount: number;
}

/**
 * Serve the recorded events once, in ledger order. A second call returns an
 * empty batch, mirroring an RPC that has nothing past the cursor.
 */
export function createReplayRpc(fixtures: RpcFixture[]): ReplayRpc {
  const events = fixtures
    .flatMap((f) => f.events)
    .sort((a, b) => a.ledger - b.ledger);
  const latestLedger = fixtures.reduce((max, f) => Math.max(max, f.latestLedger), 0);

  let served = false;
  const rpc: ReplayRpc = {
    callCount: 0,
    async getLatestLedger() {
      return { sequence: latestLedger };
    },
    async getEvents({ startLedger, filters }) {
      rpc.callCount += 1;
      if (served) return { events: [], latestLedger };
      served = true;
      const wanted = filters?.[0]?.contractIds;
      const batch = events.filter(
        (e) =>
          e.ledger >= startLedger && (!wanted?.length || wanted.includes(e.contractId)),
      );
      return { events: batch, latestLedger };
    },
  };
  return rpc;
}

export type Row = Record<string, unknown>;

export interface FakeDb {
  query: (sql: string, params?: unknown[]) => Promise<Row[]>;
  indexedEvents: Row[];
  positions: Row[];
  epochs: Row[];
  vaults: Row[];
  tvlSnapshots: Row[];
  unknownSql: string[];
}

function fakeDbError(message: string): never {
  throw new Error(`createFakeDb: ${message}`);
}

/**
 * Minimal in-memory stand-in for the statements the indexer runs while
 * processing deposit / yield_distributed / vault_state_changed events. It
 * performs the real upsert semantics for the tables the replay asserts on.
 */
export function createFakeDb(vaultContractId: string): FakeDb {
  const db: FakeDb = {
    indexedEvents: [],
    positions: [],
    epochs: [],
    vaults: [
      {
        id: 1,
        contract_id: vaultContractId,
        total_assets: "0",
        total_supply: "1000",
        funding_target: "1000000",
        operator_fee_bps: 100,
        state: "Funding",
        total_shares_ever_minted: "0",
        total_shares_ever_burned: "0",
      },
    ],
    tvlSnapshots: [],
    unknownSql: [],
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
      const p = params as unknown[];
      const vault = (contractId: unknown) =>
        db.vaults.find((v) => v.contract_id === contractId);
      const vaultById = (id: unknown) => db.vaults.find((v) => v.id === id);

      if (norm.startsWith("select contract_id, indexing_paused")) return [];
      if (norm.startsWith("select last_ledger from indexer_state")) return [];
      if (norm.startsWith("insert into indexer_state")) return [];

      if (norm.startsWith("select id from indexed_events where tx_hash")) {
        const found = db.indexedEvents.find(
          (e) =>
            e.tx_hash === p[0] &&
            e.contract_id === p[1] &&
            e.event_type === p[2] &&
            e.ledger === p[3],
        );
        return found ? [{ id: db.indexedEvents.indexOf(found) + 1 }] : [];
      }

      if (
        norm.startsWith(
          "insert into user_vault_positions (user_address, vault_id, shares, deposited, updated_at, first_entry_at)",
        )
      ) {
        const [user, shares, deposited, contractId] = p;
        const v = vault(contractId);
        if (!v) return fakeDbError(`no vault for contract ${String(contractId)}`);
        const existing = db.positions.find(
          (row) => row.user_address === user && row.vault_id === v.id,
        );
        if (existing) {
          existing.shares = (BigInt(String(existing.shares)) + BigInt(String(shares))).toString();
          existing.deposited = (
            BigInt(String(existing.deposited)) + BigInt(String(deposited))
          ).toString();
          existing.updated_at = new Date().toISOString();
        } else {
          db.positions.push({
            user_address: user,
            vault_id: v.id,
            shares,
            deposited,
            first_entry_at: new Date().toISOString(),
            last_exit_at: null,
            updated_at: new Date().toISOString(),
          });
        }
        return [];
      }

      if (norm.startsWith("select total_assets, funding_target from vaults")) {
        const v = vault(p[0]);
        return v
          ? [{ total_assets: v.total_assets, funding_target: v.funding_target }]
          : [];
      }

      if (norm.startsWith("update vaults set total_assets = $1")) {
        const [totalAssets, minted, contractId] = p;
        const v = vault(contractId);
        if (v) {
          v.total_assets = totalAssets;
          v.total_shares_ever_minted = (
            BigInt(String(v.total_shares_ever_minted)) + BigInt(String(minted))
          ).toString();
        }
        return [];
      }

      if (norm.startsWith("select id, total_assets, total_supply from vaults")) {
        const v = vault(p[0]);
        return v
          ? [{ id: v.id, total_assets: v.total_assets, total_supply: v.total_supply }]
          : [];
      }

      if (norm.startsWith("insert into vault_tvl_snapshots")) {
        db.tvlSnapshots.push({
          vault_id: p[0],
          total_assets: p[1],
          total_supply: p[2],
        });
        return [];
      }

      if (norm.startsWith("insert into indexed_events")) {
        const row =
          p.length >= 6
            ? {
                ledger: p[0],
                tx_hash: p[1],
                contract_id: p[2],
                event_type: p[3],
                payload: p[4],
                parsed_data: p[5],
              }
            : {
                ledger: p[0],
                tx_hash: p[1],
                contract_id: p[2],
                event_type: "yield_distributed",
                payload: p[3],
                parsed_data: null,
              };
        const duplicate = db.indexedEvents.some(
          (e) =>
            e.tx_hash === row.tx_hash &&
            e.contract_id === row.contract_id &&
            e.event_type === row.event_type &&
            e.ledger === row.ledger,
        );
        if (!duplicate) db.indexedEvents.push(row);
        return [];
      }

      if (norm.startsWith("select shares from user_vault_positions uvp join vaults")) {
        const [contractId, user] = p;
        const v = vault(contractId);
        const pos = db.positions.find(
          (row) => row.user_address === user && row.vault_id === v?.id,
        );
        return pos ? [{ shares: pos.shares }] : [];
      }

      if (norm.startsWith("select id, operator_fee_bps from vaults")) {
        const v = vault(p[0]);
        return v ? [{ id: v.id, operator_fee_bps: v.operator_fee_bps }] : [];
      }

      if (norm.startsWith("select total_supply from vaults where id")) {
        const v = vaultById(p[0]);
        return v ? [{ total_supply: v.total_supply }] : [];
      }

      if (norm.startsWith("insert into epochs")) {
        const [vaultId, epoch, yieldAmount, totalShares] = p;
        const duplicate = db.epochs.some(
          (e) => e.vault_id === vaultId && e.epoch === epoch,
        );
        if (!duplicate) {
          db.epochs.push({
            vault_id: vaultId,
            epoch,
            yield_amount: yieldAmount,
            total_shares: totalShares,
            distributed_at: new Date().toISOString(),
          });
        }
        return [];
      }

      if (norm.startsWith("insert into share_balance_snapshots")) return [];

      if (norm.startsWith("update vaults set state = $1")) {
        const [state, contractId] = p;
        const v = vault(contractId);
        if (v) v.state = state;
        return [];
      }

      if (norm.startsWith("select shares, deposited from user_vault_positions")) return [];

      db.unknownSql.push(sql);
      return [];
    },
  };

  return db;
}
