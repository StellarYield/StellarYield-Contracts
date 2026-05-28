import type { Vault, UserVaultPosition, PaginatedResponse } from "../types/index.js";
import { query } from "../db/index.js";
import { logger } from "../logger.js";

interface ListVaultsOptions {
  page: number;
  pageSize: number;
  state?: string;
}

export class VaultService {
  async listVaults(_opts: ListVaultsOptions): Promise<PaginatedResponse<Vault>> {
    throw new Error("Not implemented");
  }

  async getVault(_contractId: string): Promise<Vault | null> {
    throw new Error("Not implemented");
  }

  async getVaultPositions(_contractId: string): Promise<UserVaultPosition[]> {
    throw new Error("Not implemented");
  }

  async upsertVault(vault: Partial<Vault> & { contractId: string }): Promise<void> {
    const {
      contractId,
      factoryId = null,
      asset = "",
      name = null,
      symbol = null,
      state = "Funding",
      totalAssets = "0",
      totalSupply = "0",
    } = vault;

    logger.info(
      { contractId, factoryId, name, asset },
      "Upserting vault into database",
    );

    await query(
      `INSERT INTO vaults (contract_id, factory_id, asset, name, symbol, state, total_assets, total_supply, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (contract_id)
       DO UPDATE SET
         factory_id = COALESCE(EXCLUDED.factory_id, vaults.factory_id),
         asset = COALESCE(EXCLUDED.asset, vaults.asset),
         name = COALESCE(EXCLUDED.name, vaults.name),
         symbol = COALESCE(EXCLUDED.symbol, vaults.symbol),
         state = COALESCE(EXCLUDED.state, vaults.state),
         total_assets = COALESCE(EXCLUDED.total_assets, vaults.total_assets),
         total_supply = COALESCE(EXCLUDED.total_supply, vaults.total_supply),
         updated_at = NOW()`,
      [contractId, factoryId, asset, name, symbol, state, totalAssets, totalSupply],
    );

    logger.info({ contractId }, "Vault upserted successfully");
  }
}
