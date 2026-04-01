import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { encodeBatchVaultParams, encodeBytes32, scAddress } from "./encode.js";
import type { BatchVaultParams, CreateVaultParams } from "./types.js";
import type { SorobanOperation } from "./transaction.js";

/**
 * Typed invoke helpers for `VaultFactory` (registry + deployment).
 * Each method returns a **single** Soroban host invocation operation — wrap with
 * {@link buildUnsignedTransaction} from `./transaction.js` to form a `Transaction`.
 */
export class VaultFactoryClient {
  constructor(public readonly contractId: string) {}

  private c(): Contract {
    return new Contract(this.contractId);
  }

  createSingleRwaVault(input: {
    caller: string;
    asset: string;
    name: string;
    symbol: string;
    rwaName: string;
    rwaSymbol: string;
    rwaDocumentUri: string;
    maturityDate: bigint;
  }): SorobanOperation {
    return this.c().call(
      "create_single_rwa_vault",
      scAddress(input.caller),
      scAddress(input.asset),
      nativeToScVal(input.name),
      nativeToScVal(input.symbol),
      nativeToScVal(input.rwaName),
      nativeToScVal(input.rwaSymbol),
      nativeToScVal(input.rwaDocumentUri),
      nativeToScVal(input.maturityDate, { type: "u64" }),
    );
  }

  createSingleRwaVaultFull(input: {
    caller: string;
    params: CreateVaultParams;
  }): SorobanOperation {
    return this.c().call(
      "create_single_rwa_vault_full",
      scAddress(input.caller),
      encodeBatchVaultParams(input.params),
    );
  }

  batchCreateVaults(input: {
    caller: string;
    params: BatchVaultParams[];
  }): SorobanOperation {
    const vec = nativeToScVal(
      input.params.map((p) => ({
        asset: Address.fromString(p.asset),
        name: p.name,
        symbol: p.symbol,
        rwa_name: p.rwa_name,
        rwa_symbol: p.rwa_symbol,
        rwa_document_uri: p.rwa_document_uri,
        rwa_category: p.rwa_category,
        expected_apy: p.expected_apy,
        maturity_date: p.maturity_date,
        funding_deadline: p.funding_deadline,
        funding_target: p.funding_target,
        min_deposit: p.min_deposit,
        max_deposit_per_user: p.max_deposit_per_user,
        early_redemption_fee_bps: p.early_redemption_fee_bps,
      })),
    );
    return this.c().call("batch_create_vaults", scAddress(input.caller), vec);
  }

  createAggregatorVault(input: {
    caller: string;
    asset: string;
    name: string;
    symbol: string;
  }): SorobanOperation {
    return this.c().call(
      "create_aggregator_vault",
      scAddress(input.caller),
      scAddress(input.asset),
      nativeToScVal(input.name),
      nativeToScVal(input.symbol),
    );
  }

  removeVault(input: { caller: string; vault: string }): SorobanOperation {
    return this.c().call(
      "remove_vault",
      scAddress(input.caller),
      scAddress(input.vault),
    );
  }

  setVaultStatus(input: {
    caller: string;
    vault: string;
    active: boolean;
  }): SorobanOperation {
    return this.c().call(
      "set_vault_status",
      scAddress(input.caller),
      scAddress(input.vault),
      nativeToScVal(input.active),
    );
  }

  getAllVaults(): SorobanOperation {
    return this.c().call("get_all_vaults");
  }

  getSingleRwaVaults(): SorobanOperation {
    return this.c().call("get_single_rwa_vaults");
  }

  getVaultInfo(vault: string): SorobanOperation {
    return this.c().call("get_vault_info", scAddress(vault));
  }

  isRegisteredVault(vault: string): SorobanOperation {
    return this.c().call("is_registered_vault", scAddress(vault));
  }

  getVaultCount(): SorobanOperation {
    return this.c().call("get_vault_count");
  }

  getActiveVaults(): SorobanOperation {
    return this.c().call("get_active_vaults");
  }

  getVaultsByAsset(asset: string): SorobanOperation {
    return this.c().call("get_vaults_by_asset", scAddress(asset));
  }

  getVaultsPaginated(offset: number, limit: number): SorobanOperation {
    return this.c().call(
      "get_vaults_paginated",
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    );
  }

  getActiveVaultsPaginated(offset: number, limit: number): SorobanOperation {
    return this.c().call(
      "get_active_vaults_paginated",
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    );
  }

  aggregatorVault(): SorobanOperation {
    return this.c().call("aggregator_vault");
  }

  transferAdmin(input: { caller: string; newAdmin: string }): SorobanOperation {
    return this.c().call(
      "transfer_admin",
      scAddress(input.caller),
      scAddress(input.newAdmin),
    );
  }

  setOperator(input: {
    caller: string;
    operator: string;
    status: boolean;
  }): SorobanOperation {
    return this.c().call(
      "set_operator",
      scAddress(input.caller),
      scAddress(input.operator),
      nativeToScVal(input.status),
    );
  }

  setDefaults(input: {
    caller: string;
    asset: string;
    zkmeVerifier: string;
    cooperator: string;
  }): SorobanOperation {
    return this.c().call(
      "set_defaults",
      scAddress(input.caller),
      scAddress(input.asset),
      scAddress(input.zkmeVerifier),
      scAddress(input.cooperator),
    );
  }

  setVaultWasmHash(input: { caller: string; hash: string | Uint8Array }): SorobanOperation {
    return this.c().call(
      "set_vault_wasm_hash",
      scAddress(input.caller),
      encodeBytes32(input.hash),
    );
  }

  admin(): SorobanOperation {
    return this.c().call("admin");
  }

  isOperator(account: string): SorobanOperation {
    return this.c().call("is_operator", scAddress(account));
  }

  defaultAsset(): SorobanOperation {
    return this.c().call("default_asset");
  }

  defaultZkmeVerifier(): SorobanOperation {
    return this.c().call("default_zkme_verifier");
  }

  defaultCooperator(): SorobanOperation {
    return this.c().call("default_cooperator");
  }

  /** Low-level escape hatch for forward compatibility. */
  invoke(method: string, ...args: xdr.ScVal[]): SorobanOperation {
    return this.c().call(method, ...args);
  }
}
