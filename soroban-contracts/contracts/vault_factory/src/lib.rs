#![no_std]

mod errors;
mod events;
mod migrations;
mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_factory_migration;
#[cfg(test)]
mod tests;

pub use crate::types::*;

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env, String, Vec};

use crate::errors::Error;
use crate::events::*;
use crate::migrations::CURRENT_SCHEMA_VERSION;
use crate::storage::*;

/// Maximum number of vaults that can be created in a single batch call.
/// Contract deployment is one of the most expensive Soroban operations;
/// exceeding this limit risks exhausting the transaction's CPU budget.
const MAX_BATCH_SIZE: u32 = 10;

/// Maximum page size for status-filtered vault list queries.
const MAX_STATUS_PAGE_SIZE: u32 = 50;

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
        require_valid_address(e, &admin);
        require_valid_address(e, &default_asset);
        require_valid_address(e, &zkme_verifier);
        require_valid_address(e, &cooperator);
        
        put_admin(e, admin.clone());
        put_default_asset(e, default_asset);
        put_default_zkme_verifier(e, zkme_verifier);
        put_default_cooperator(e, cooperator);
        put_vault_wasm_hash(e, vault_wasm_hash);
        put_default_fee_bps(e, 200u32);
        put_operator(e, admin, true);
        // Versioning
        put_contract_version(e, 1u32);
        put_storage_schema_version(e, 1u32);
        bump_instance(e);
    }

    // ─────────────────────────────────────────────────────────────────
    // Versioning and migration
    // ─────────────────────────────────────────────────────────────────

    /// Admin-only migration entry point. Updates storage schema to the latest version.
    /// No-op if already up-to-date.
    pub fn migrate(e: &Env, caller: Address) {
        caller.require_auth();
        require_admin(e, &caller);

        let old_version = get_storage_schema_version(e);
        if old_version >= CURRENT_SCHEMA_VERSION {
            return;
        }

        crate::migrations::run_migrations(e, old_version);
        emit_data_migrated(e, old_version, CURRENT_SCHEMA_VERSION);
        bump_instance(e);
    }

    pub fn storage_schema_version(e: &Env) -> u32 {
        get_storage_schema_version(e)
    }

    pub fn contract_version(e: &Env) -> u32 {
        get_contract_version(e)
    }

    pub fn version(e: &Env) -> u32 {
        get_contract_version(e)
    }

    // ─────────────────────────────────────────────────────────────────
    // Vault creation – simple (mirrors createSingleRWAVault)
    // ─────────────────────────────────────────────────────────────────

    /// Create a minimal single-RWA vault.
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
        require_current_schema(e);
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
        require_current_schema(e);
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
        )
    }

    /// Create a fully parameterised single-RWA vault.
    ///
    /// Parameters are passed as a `CreateVaultParams` struct to stay within
    /// Soroban's 10-argument limit per contract function.
    pub fn create_single_rwa_vault_batch(
        e: &Env,
        caller: Address,
        params: CreateVaultParams,
    ) -> Address {
        caller.require_auth();
        require_current_schema(e);
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
        require_current_schema(e);
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

        // Registry cleanup: remove from asset-specific list and the indexed registry
        remove_from_vaults_by_asset(e, &info.asset, &vault);
        unregister_vault(e, vault.clone());

        // Delete persistent VaultInfo entry
        delete_vault_info(e, &vault);

        emit_vault_removed(e, vault, caller);
        bump_instance(e);
    }

    pub fn set_vault_status(e: &Env, caller: Address, vault: Address, active: bool) {
        caller.require_auth();
        require_current_schema(e);
        require_admin(e, &caller);

        let mut info = get_vault_info(e, &vault).unwrap_or_else(|| panic_not_found(e));

        // Vault status is tracked in VaultInfo.

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
    /// **Note:** Iterates through indexed storage up to VaultCount.
    pub fn get_all_vaults(e: &Env) -> Vec<Address> {
        let count = get_vault_count(e);
        let mut result = Vec::new(e);
        for i in 0..count {
            if let Some(vault) = get_vault_at_index(e, i) {
                result.push_back(vault);
            }
        }
        result
    }

    /// Returns every registered SingleRWA vault address.
    ///
    /// **Note:** Iterates and filters by vault_type.
    pub fn get_single_rwa_vaults(e: &Env) -> Vec<Address> {
        let count = get_vault_count(e);
        let mut result = Vec::new(e);
        for i in 0..count {
            if let Some(vault) = get_vault_at_index(e, i) {
                if let Some(info) = get_vault_info(e, &vault) {
                    if info.vault_type == VaultType::SingleRwa {
                        result.push_back(vault);
                    }
                }
            }
        }
        result
    }

    pub fn get_vault_info(e: &Env, vault: Address) -> Option<VaultInfo> {
        get_vault_info(e, &vault)
    }

    pub fn is_registered_vault(e: &Env, vault: Address) -> bool {
        get_vault_info(e, &vault).is_some()
    }

    /// Checks if a vault with the given name and symbol already exists.
    ///
    /// Returns `Option<Address>` with the vault address if found, `None` otherwise.
    ///
    /// This helper supports safer vault creation by allowing pre-validation of
    /// naming collisions before attempting deployment. Useful for UX to warn
    /// integrators about potential duplicates.
    ///
    /// # Arguments
    /// * `name` - The RWA name to search for
    /// * `symbol` - The RWA symbol to search for
    ///
    /// # Returns
    /// `Some(vault_address)` if a vault with matching name and symbol exists,
    /// `None` otherwise
    pub fn vault_exists_by_name_symbol(
        e: &Env,
        name: String,
        symbol: String,
    ) -> Option<Address> {
        let count = get_vault_count(e);
        for i in 0..count {
            if let Some(vault) = get_vault_at_index(e, i) {
                if let Some(info) = get_vault_info(e, &vault) {
                    if info.name == name && info.symbol == symbol {
                        return Some(vault);
                    }
                }
            }
        }
        None
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
        let count = get_vault_count(e);
        let mut result = Vec::new(e);
        for i in 0..count {
            if let Some(vault) = get_vault_at_index(e, i) {
                if let Some(info) = get_vault_info(e, &vault) {
                    if info.active {
                        result.push_back(vault);
                    }
                }
            }
        }
        result
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
        let total = get_vault_count(e);
        let mut result: Vec<Address> = Vec::new(e);
        if offset >= total || limit == 0 {
            return result;
        }
        let end = (offset + limit).min(total);
        for i in offset..end {
            if let Some(vault) = get_vault_at_index(e, i) {
                result.push_back(vault);
            }
        }
        result
    }

    /// Returns a page of *active* vault addresses.
    ///
    /// `offset` is zero-based within the active-vault list. Returns an empty
    /// vec when `offset >= active count` or `limit == 0`.
    pub fn get_active_vaults_paginated(e: &Env, offset: u32, limit: u32) -> Vec<Address> {
        let count = get_vault_count(e);
        let mut result: Vec<Address> = Vec::new(e);
        if limit == 0 {
            return result;
        }

        let mut current_offset = 0;
        let mut count_added = 0;

        for i in 0..count {
            if let Some(vault) = get_vault_at_index(e, i) {
                if let Some(info) = get_vault_info(e, &vault) {
                    if info.active {
                        if current_offset >= offset {
                            result.push_back(vault);
                            count_added += 1;
                            if count_added >= limit {
                                break;
                            }
                        }
                        current_offset += 1;
                    }
                }
            }
        }
        result
    }

    pub fn aggregator_vault(e: &Env) -> Option<Address> {
        get_aggregator_vault(e)
    }

    /// Returns all factory-level defaults in a single call.
    ///
    /// Useful for vault creation forms and deployment scripts that need the
    /// current default asset, verifier, cooperator, fee bps, and wasm hash
    /// without making five separate contract calls.
    pub fn get_defaults_snapshot(e: &Env) -> FactoryDefaultsSnapshot {
        bump_instance(e);
        FactoryDefaultsSnapshot {
            default_asset: get_default_asset(e),
            zkme_verifier: get_default_zkme_verifier(e),
            cooperator: get_default_cooperator(e),
            fee_bps: get_default_fee_bps(e),
            vault_wasm_hash: get_vault_wasm_hash(e),
        }
    }

    /// Returns compact statistics about the vault registry.
    ///
    /// Aggregates key metrics in a single call to reduce query overhead from
    /// explorers and monitoring dashboards:
    ///
    /// - `total_vaults`: Total count of all registered vaults (all states)
    /// - `active_vaults`: Count of vaults with `active` flag set to true
    /// - `latest_vault`: Most recently deployed vault address (if any exist)
    ///
    /// # Returns
    /// A `RegistryStats` struct containing the three metrics
    pub fn get_registry_stats(e: &Env) -> RegistryStats {
        let count = get_vault_count(e);
        let mut active_count = 0u32;
        let mut latest_vault_addr: Option<Address> = None;

        // Iterate through all vaults to count active and track the latest
        for i in 0..count {
            if let Some(vault) = get_vault_at_index(e, i) {
                // Update latest_vault to the most recently deployed (highest index)
                latest_vault_addr = Some(vault.clone());

                if let Some(info) = get_vault_info(e, &vault) {
                    if info.active {
                        active_count += 1;
                    }
                }
            }
        }

        RegistryStats {
            total_vaults: count,
            active_vaults: active_count,
            latest_vault: latest_vault_addr,
        }
    }

    /// Returns a status-filtered page of vault addresses.
    ///
    /// `status` must be `VaultStatus::Active` or `VaultStatus::Inactive`.
    /// `offset` is zero-based within the filtered set.
    /// `limit` is capped at `MAX_STATUS_PAGE_SIZE` (50) to prevent expensive queries.
    /// Returns an empty vec when the filtered set is empty or `offset` is out of range.
    pub fn list_vaults_by_status(
        e: &Env,
        status: VaultStatus,
        offset: u32,
        limit: u32,
    ) -> Vec<Address> {
        let capped = limit.min(MAX_STATUS_PAGE_SIZE);
        let total = get_vault_count(e);
        let mut result: Vec<Address> = Vec::new(e);
        if capped == 0 {
            return result;
        }
        let want_active = status == VaultStatus::Active;
        let mut cursor: u32 = 0;
        for i in 0..total {
            if let Some(vault) = get_vault_at_index(e, i) {
                if let Some(info) = get_vault_info(e, &vault) {
                    if info.active == want_active {
                        if cursor >= offset {
                            result.push_back(vault);
                            if result.len() >= capped {
                                break;
                            }
                        }
                        cursor += 1;
                    }
                }
            }
        }
        result
    }

    // ─────────────────────────────────────────────────────────────────
    // Admin functions
    // ─────────────────────────────────────────────────────────────────

    pub fn transfer_admin(e: &Env, caller: Address, new_admin: Address) {
        caller.require_auth();
        require_current_schema(e);
        require_admin(e, &caller);
        require_valid_address(e, &new_admin);
        let old = get_admin(e);
        put_admin(e, new_admin.clone());
        emit_admin_transferred(e, old, new_admin);
        bump_instance(e);
    }

    /// Grant `role` to `addr`.  Only the admin may grant roles.
    ///
    /// `FullOperator` is the backward-compatible superrole that passes every
    /// role check (equivalent to the old `set_operator(..., true)`).
    pub fn grant_role(e: &Env, caller: Address, addr: Address, role: Role) {
        caller.require_auth();
        require_current_schema(e);
        require_admin(e, &caller);
        require_valid_address(e, &addr);
        put_role(e, addr.clone(), role.clone(), true);
        emit_role_granted(e, addr, role);
        bump_instance(e);
    }

    /// Revoke `role` from `addr`.  Only the admin may revoke roles.
    pub fn revoke_role(e: &Env, caller: Address, addr: Address, role: Role) {
        caller.require_auth();
        require_current_schema(e);
        require_admin(e, &caller);
        put_role(e, addr.clone(), role.clone(), false);
        emit_role_revoked(e, addr, role);
        bump_instance(e);
    }

    /// Returns `true` when `addr` holds `role`, the `FullOperator` superrole,
    /// or is the admin.
    pub fn has_role(e: &Env, addr: Address, role: Role) -> bool {
        if addr == get_admin(e) {
            return true;
        }
        get_role(e, &addr, Role::FullOperator) || get_role(e, &addr, role)
    }

    /// Backward-compatible: grants or revokes the `FullOperator` superrole.
    /// Prefer `grant_role` / `revoke_role` for new integrations.
    pub fn set_operator(e: &Env, caller: Address, operator: Address, status: bool) {
        caller.require_auth();
        require_admin(e, &caller);
        require_valid_address(e, &operator);
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
        require_current_schema(e);
        require_admin(e, &caller);
        require_valid_address(e, &asset);
        require_valid_address(e, &zkme_verifier);
        require_valid_address(e, &cooperator);
        put_default_asset(e, asset.clone());
        put_default_zkme_verifier(e, zkme_verifier.clone());
        put_default_cooperator(e, cooperator.clone());
        emit_defaults_updated(e, asset, zkme_verifier, cooperator);
        bump_instance(e);
    }

    pub fn set_vault_wasm_hash(e: &Env, caller: Address, hash: BytesN<32>) {
        caller.require_auth();
        require_admin(e, &caller);
        if hash == BytesN::from_array(e, &[0u8; 32]) {
            panic_with_error!(e, Error::InvalidWasmHash);
        }
        put_vault_wasm_hash(e, hash.clone());
        emit_wasm_hash_updated(e, hash, caller);
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

    pub fn vault_wasm_hash(e: &Env) -> BytesN<32> {
        get_vault_wasm_hash(e)
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
        salt_bytes.append(&soroban_sdk::Bytes::from_slice(
            e,
            &e.ledger().timestamp().to_be_bytes(),
        ));
        let salt = e.crypto().sha256(&salt_bytes);

        // Build the InitParams struct for the vault constructor.
        // Using a struct keeps us under Soroban's 10-arg limit per function.
        let init_params = SingleRwaVaultInitParams {
            asset: vault_asset.clone(),
            share_name: name.clone(),
            share_symbol: symbol.clone(),
            share_decimals: 6u32, // USDC convention
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
        register_vault(e, vault_addr.clone());
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

/// Validates that an address is not the zero-equivalent (contract's own address).
/// This prevents null-like semantics where the contract address is used as a placeholder.
fn require_valid_address(e: &Env, addr: &Address) {
    if *addr == e.current_contract_address() {
        panic_with_error!(e, Error::InvalidInitParams);
    }
}

fn require_admin(e: &Env, caller: &Address) {
    if *caller != get_admin(e) {
        panic_with_error!(e, Error::NotAuthorized);
    }
}

/// Passes when `caller` holds `role`, the `FullOperator` superrole, or is admin.
fn require_role(e: &Env, caller: &Address, role: Role) {
    if *caller == get_admin(e) {
        return;
    }
    if get_role(e, caller, Role::FullOperator) {
        return;
    }
    if !get_role(e, caller, role) {
        panic_with_error!(e, Error::NotAuthorized);
    }
}

fn require_operator_or_admin(e: &Env, caller: &Address) {
    // Vault creation requires FullOperator or admin (backward-compatible).
    require_role(e, caller, Role::FullOperator);
}

/// Require that storage schema is current; panics with MigrationRequired otherwise.
/// Skipped for migrate, version, and admin functions.
fn require_current_schema(e: &Env) {
    if get_storage_schema_version(e) != CURRENT_SCHEMA_VERSION {
        panic_with_error!(e, Error::MigrationRequired);
    }
}

fn panic_not_found(e: &Env) -> ! {
    panic_with_error!(e, Error::VaultNotFound);
}
