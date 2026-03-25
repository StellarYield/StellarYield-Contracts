#![no_std]

mod errors;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod tests;

pub use crate::types::*;

use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env, String, Vec, xdr::ToXdr};

use crate::errors::Error;
use crate::events::*;
use crate::storage::*;

/// Maximum number of vaults that can be created in a single batch call.
/// Contract deployment is one of the most expensive Soroban operations;
/// exceeding this limit risks exhausting the transaction's CPU budget.
const MAX_BATCH_SIZE: u32 = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct VaultFactory;

#[contractimpl]
impl VaultFactory {
    // ─────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────

    /// Initialise the factory.
    ///
    /// `vault_wasm_hash` is the WASM hash of the deployed SingleRWA_Vault
    /// contract binary (obtained after `stellar contract upload`).
    pub fn __constructor(
        e: &Env,
        admin: Address,
        default_asset: Address,
        zkme_verifier: Address,
        cooperator: Address,
        vault_wasm_hash: BytesN<32>,
    ) {
        put_admin(e, admin.clone());
        put_default_asset(e, default_asset);
        put_default_zkme_verifier(e, zkme_verifier);
        put_default_cooperator(e, cooperator);
        put_vault_wasm_hash(e, vault_wasm_hash);
        put_operator(e, admin, true);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Vault creation – simple (mirrors createSingleRWAVault)
    // ─────────────────────────────────────────────────────────────────

    /// Create a minimal single-RWA vault.
    ///
    /// This uses `share_decimals=7` (SEP-41 convention) by default.
    /// For non-USDC assets, use `create_single_rwa_vault_full` and set
    /// `share_decimals` explicitly to avoid mis-scaling asset/share ratios.
    pub fn create_single_rwa_vault(
        e: &Env,
        caller: Address,
        asset: Address,
        name: String,
        symbol: String,
        rwa_name: String,
        rwa_symbol: String,
        rwa_document_uri: String,
        maturity_date: u64,
    ) -> Address {
        caller.require_auth();
        require_operator_or_admin(e, &caller);

        let zero_str = String::from_str(e, "");
        Self::_create_single_rwa_vault(
            e,
            asset,
            name,
            symbol,
            rwa_name,
            rwa_symbol,
            rwa_document_uri,
            zero_str, // category
            0u32,     // expected_apy
            maturity_date,
            0u64,   // funding_deadline (0 = no deadline)
            0i128,  // funding_target
            0i128,  // min_deposit
            0i128,  // max_deposit_per_user
            200u32, // early_redemption_fee_bps (2 %)
            7u32,   // share_decimals default SEP-41 convention
        )
    }

    /// Create a fully parameterised single-RWA vault.
    ///
    /// Parameters are passed as a `CreateVaultParams` struct to stay within
    /// Soroban's 10-argument limit per contract function.
    pub fn create_single_rwa_vault_full(
        e: &Env,
        caller: Address,
        params: CreateVaultParams,
    ) -> Address {
        caller.require_auth();
        require_operator_or_admin(e, &caller);

        Self::_create_single_rwa_vault(
            e,
            params.asset,
            params.name,
            params.symbol,
            params.rwa_name,
            params.rwa_symbol,
            params.rwa_document_uri,
            params.rwa_category,
            params.expected_apy,
            params.maturity_date,
            params.funding_deadline,
            params.funding_target,
            params.min_deposit,
            params.max_deposit_per_user,
            params.early_redemption_fee_bps,
            params.share_decimals,
        )
    }

    /// Batch-create multiple vaults in one transaction.
    ///
    /// The batch size is capped at `MAX_BATCH_SIZE` (10) to prevent gas
    /// exhaustion from unbounded contract deployments.
    pub fn batch_create_vaults(
        e: &Env,
        caller: Address,
        params: Vec<BatchVaultParams>,
    ) -> Vec<Address> {
        caller.require_auth();
        require_operator_or_admin(e, &caller);

        if params.len() > MAX_BATCH_SIZE {
            panic_with_error!(e, Error::BatchTooLarge);
        }

        let mut vaults: Vec<Address> = Vec::new(e);
        for i in 0..params.len() {
            let p = params.get(i).unwrap();
            let vault = Self::_create_single_rwa_vault(
                e,
                p.asset,
                p.name,
                p.symbol,
                p.rwa_name,
                p.rwa_symbol,
                p.rwa_document_uri,
                p.rwa_category,
                p.expected_apy,
                p.maturity_date,
                p.funding_deadline,
                p.funding_target,
                p.min_deposit,
                p.max_deposit_per_user,
                p.early_redemption_fee_bps,
                p.share_decimals,
            );
            vaults.push_back(vault);
        }
        vaults
    }

    /// Aggregator vault is not supported (mirrors the Solidity version).
    pub fn create_aggregator_vault(
        e: &Env,
        _caller: Address,
        _asset: Address,
        _name: String,
        _symbol: String,
    ) -> Address {
        panic_with_error!(e, Error::NotSupported);
    }

    // ─────────────────────────────────────────────────────────────────
    // Vault management
    // ─────────────────────────────────────────────────────────────────

    /// Remove an inactive vault from the factory registry.
    ///
    /// - Caller must be the admin.
    /// - Vault must be registered.
    /// - Vault must be inactive (set via `set_vault_status`); active vaults
    ///   cannot be removed to protect depositors.
    ///
    /// On success the vault is purged from both `AllVaults` and
    /// `SingleRwaVaults` (if present) and its `VaultInfo` entry is deleted.
    /// A `VaultRemoved` event is emitted.
    pub fn remove_vault(e: &Env, caller: Address, vault: Address) {
        caller.require_auth();
        require_admin(e, &caller);

        // Vault must exist
        let info = get_vault_info(e, &vault).unwrap_or_else(|| panic_not_found(e));

        // Guard: only inactive vaults may be removed
        if info.active {
            panic_with_error!(e, Error::VaultIsActive);
        }

        // Remove from all registry lists (vault is already inactive — not in ActiveVaults)
        remove_from_all_vaults(e, &vault);
        if info.vault_type == VaultType::SingleRwa {
            remove_from_single_rwa_vaults(e, &vault);
        }

        // Registry cleanup: remove from asset-specific list
        remove_from_vaults_by_asset(e, &info.asset, &vault);

        // Delete persistent VaultInfo entry
        delete_vault_info(e, &vault);

        emit_vault_removed(e, vault, caller);
        bump_instance(e);
    }

    pub fn set_vault_status(e: &Env, caller: Address, vault: Address, active: bool) {
        caller.require_auth();
        require_admin(e, &caller);

        let mut info = get_vault_info(e, &vault).unwrap_or_else(|| panic_not_found(e));

        // Keep ActiveVaults in sync when the flag changes.
        if active && !info.active {
            push_active_vaults(e, vault.clone());
        } else if !active && info.active {
            remove_from_active_vaults(e, &vault);
        }

        info.active = active;
        put_vault_info(e, &vault, info);
        emit_vault_status_changed(e, vault, active);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────────

    /// Returns every registered vault address.
    ///
    /// **Note:** loads the full vault list from persistent storage.
    /// For large registries prefer `get_vaults_paginated`.
    pub fn get_all_vaults(e: &Env) -> Vec<Address> {
        get_all_vaults(e)
    }

    /// Returns every registered SingleRWA vault address.
    ///
    /// **Note:** loads the full list from persistent storage.
    pub fn get_single_rwa_vaults(e: &Env) -> Vec<Address> {
        get_single_rwa_vaults(e)
    }

    pub fn get_vault_info(e: &Env, vault: Address) -> Option<VaultInfo> {
        get_vault_info(e, &vault)
    }

    pub fn is_registered_vault(e: &Env, vault: Address) -> bool {
        get_vault_info(e, &vault).is_some()
    }

    /// Returns the current number of registered vaults.
    ///
    /// Reads a dedicated counter from instance storage — does not load the
    /// full vault list.
    pub fn get_vault_count(e: &Env) -> u32 {
        get_vault_count(e)
    }

    /// Returns all vaults whose `active` flag is set.
    pub fn get_active_vaults(e: &Env) -> Vec<Address> {
        get_active_vaults(e)
    }

    /// Returns all vaults registered for a specific underlying asset.
    pub fn get_vaults_by_asset(e: &Env, asset: Address) -> Vec<Address> {
        get_vaults_by_asset(e, &asset)
    }

    /// Returns a page of vault addresses from the full registry.
    ///
    /// `offset` is zero-based. Returns an empty vec when `offset >= total`.
    /// Returns fewer than `limit` entries when the end of the list is reached.
    pub fn get_vaults_paginated(e: &Env, offset: u32, limit: u32) -> Vec<Address> {
        let all = get_all_vaults(e);
        let total = all.len();
        let mut result: Vec<Address> = Vec::new(e);
        if offset >= total || limit == 0 {
            return result;
        }
        let end = (offset + limit).min(total);
        for i in offset..end {
            result.push_back(all.get(i).unwrap());
        }
        result
    }

    /// Returns a page of *active* vault addresses.
    ///
    /// `offset` is zero-based within the active-vault list. Returns an empty
    /// vec when `offset >= active count` or `limit == 0`.
    pub fn get_active_vaults_paginated(e: &Env, offset: u32, limit: u32) -> Vec<Address> {
        let active = get_active_vaults(e);
        let total = active.len();
        let mut result: Vec<Address> = Vec::new(e);
        if offset >= total || limit == 0 {
            return result;
        }
        let end = (offset + limit).min(total);
        for i in offset..end {
            result.push_back(active.get(i).unwrap());
        }
        result
    }

    pub fn aggregator_vault(e: &Env) -> Option<Address> {
        get_aggregator_vault(e)
    }

    // ─────────────────────────────────────────────────────────────────
    // Admin functions
    // ─────────────────────────────────────────────────────────────────

    pub fn transfer_admin(e: &Env, caller: Address, new_admin: Address) {
        caller.require_auth();
        require_admin(e, &caller);
        let old = get_admin(e);
        put_admin(e, new_admin.clone());
        emit_admin_transferred(e, old, new_admin);
        bump_instance(e);
    }

    pub fn set_operator(e: &Env, caller: Address, operator: Address, status: bool) {
        caller.require_auth();
        require_admin(e, &caller);
        put_operator(e, operator.clone(), status);
        emit_operator_updated(e, operator, status);
        bump_instance(e);
    }

    pub fn set_defaults(
        e: &Env,
        caller: Address,
        asset: Address,
        zkme_verifier: Address,
        cooperator: Address,
    ) {
        caller.require_auth();
        require_admin(e, &caller);
        put_default_asset(e, asset.clone());
        put_default_zkme_verifier(e, zkme_verifier.clone());
        put_default_cooperator(e, cooperator.clone());
        emit_defaults_updated(e, asset, zkme_verifier, cooperator);
        bump_instance(e);
    }

    pub fn set_vault_wasm_hash(e: &Env, caller: Address, hash: BytesN<32>) {
        caller.require_auth();
        require_admin(e, &caller);
        put_vault_wasm_hash(e, hash);
        bump_instance(e);
    }

    pub fn admin(e: &Env) -> Address {
        get_admin(e)
    }
    pub fn is_operator(e: &Env, account: Address) -> bool {
        get_operator(e, &account)
    }
    pub fn default_asset(e: &Env) -> Address {
        get_default_asset(e)
    }
    pub fn default_zkme_verifier(e: &Env) -> Address {
        get_default_zkme_verifier(e)
    }
    pub fn default_cooperator(e: &Env) -> Address {
        get_default_cooperator(e)
    }

    // ─────────────────────────────────────────────────────────────────
    // Internal: deploy + initialise a vault
    // ─────────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    fn _create_single_rwa_vault(
        e: &Env,
        asset: Address,
        name: String,
        symbol: String,
        rwa_name: String,
        rwa_symbol: String,
        rwa_document_uri: String,
        rwa_category: String,
        expected_apy: u32,
        maturity_date: u64,
        funding_deadline: u64,
        funding_target: i128,
        min_deposit: i128,
        max_deposit_per_user: i128,
        early_redemption_fee_bps: u32,
        share_decimals: u32,
    ) -> Address {
        // --- Validation ---
        if asset == e.current_contract_address() {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if maturity_date <= e.ledger().timestamp() {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if early_redemption_fee_bps > 1000 {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if min_deposit < 0 || funding_target < 0 {
            panic_with_error!(e, Error::InvalidInitParams);
        }
        if min_deposit > 0 && max_deposit_per_user > 0 && max_deposit_per_user < min_deposit {
            panic_with_error!(e, Error::InvalidInitParams);
        }

        // --- Execution ---
        // Resolve asset
        let vault_asset = if asset == get_default_asset(e) || asset == e.current_contract_address()
        {
            // treat "self" as "use default"
            get_default_asset(e)
        } else {
            asset
        };

        let wasm_hash = get_vault_wasm_hash(e);
        let admin = get_admin(e);
        let zkme = get_default_zkme_verifier(e);
        let coop = get_default_cooperator(e);

        // Deploy a fresh vault contract instance.
        // The salt combines a monotonic counter, the vault name, and the
        // current timestamp to ensure every vault has a unique address and
        // to prevent collisions even if the registry count decreases.
        let counter = increment_vault_deploy_counter(e);
        let mut salt_bytes = soroban_sdk::Bytes::new(e);
        salt_bytes.append(&soroban_sdk::Bytes::from_slice(e, &counter.to_be_bytes()));
        salt_bytes.append(&name.clone().to_xdr(e));
        salt_bytes.append(&soroban_sdk::Bytes::from_slice(e, &e.ledger().timestamp().to_be_bytes()));
        let salt = e.crypto().sha256(&salt_bytes);

        // Build the InitParams struct for the vault constructor.
        // Using a struct keeps us under Soroban's 10-arg limit per function.
        let init_params = single_rwa_vault::InitParams {
            asset: vault_asset.clone(),
            share_name: name.clone(),
            share_symbol: symbol.clone(),
            share_decimals,
            admin: admin.clone(),
            zkme_verifier: zkme.clone(),
            cooperator: coop.clone(),
            funding_target,
            maturity_date,
            funding_deadline,
            min_deposit,
            max_deposit_per_user,
            early_redemption_fee_bps,
            rwa_name,
            rwa_symbol,
            rwa_document_uri,
            rwa_category,
            expected_apy,
        };

        let vault_addr = e
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm_hash, (init_params,));

        // Register the vault
        let info = VaultInfo {
            vault: vault_addr.clone(),
            asset: vault_asset.clone(),
            vault_type: VaultType::SingleRwa,
            name: name.clone(),
            symbol: symbol.clone(),
            active: true,
            created_at: e.ledger().timestamp(),
        };
        put_vault_info(e, &vault_addr, info);
        push_all_vaults(e, vault_addr.clone());
        push_single_rwa_vaults(e, vault_addr.clone());
        push_active_vaults(e, vault_addr.clone()); // new vaults start active
        push_vaults_by_asset(e, &vault_asset, vault_addr.clone());

        emit_vault_created(
            e,
            vault_addr.clone(),
            VaultType::SingleRwa,
            name,
            e.current_contract_address(),
        );

        bump_instance(e);
        vault_addr
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard helpers
// ─────────────────────────────────────────────────────────────────────────────

fn require_admin(e: &Env, caller: &Address) {
    if *caller != get_admin(e) {
        panic_with_error!(e, Error::NotAuthorized);
    }
}

fn require_operator_or_admin(e: &Env, caller: &Address) {
    if !get_operator(e, caller) && *caller != get_admin(e) {
        panic_with_error!(e, Error::NotAuthorized);
    }
}

fn panic_not_found(e: &Env) -> ! {
    panic_with_error!(e, Error::VaultNotFound);
}
