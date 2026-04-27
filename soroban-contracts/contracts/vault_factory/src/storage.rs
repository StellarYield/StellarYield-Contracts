//! Storage layer for VaultFactory.
//!
//! All vault registry data is Persistent (vault addresses must survive long term).
//! Global config is Instance.

use soroban_sdk::{contracttype, vec, Address, BytesN, Env, Vec};

use crate::types::{Role, VaultInfo};

// ─────────────────────────────────────────────────────────────────────────────
// TTL constants
// ─────────────────────────────────────────────────────────────────────────────

pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 518400;
pub const INSTANCE_BUMP_AMOUNT: u32 = 535000;

pub const PERSIST_LIFETIME_THRESHOLD: u32 = 1036800;
pub const PERSIST_BUMP_AMOUNT: u32 = 1069000;

// ─────────────────────────────────────────────────────────────────────────────
// Storage key enum
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Granular RBAC role assignment: (address, role) → bool.
    /// Replaces the old binary `Operator(Address)` key.
    Role(Address, Role),
    // --- Versioning ---
    ContractVersion,
    StorageSchemaVersion,
    DefaultAsset,
    DefaultZkmeVerifier,
    DefaultCooperator,
    VaultWasmHash,
    AggregatorVault,
    VaultAtIndex(u32),
    VaultInfo(Address),
    VaultCount,
    VaultDeployCounter,
    /// Monotonic deploy id → vault address mapping (persistent).
    ///
    /// This preserves deterministic "most recent vaults" ordering even when
    /// vaults are removed from the indexed registry (which uses swap-remove).
    VaultByDeployId(u32),
    VaultsByAsset(Address),
    DefaultFeeBps,
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL bump helpers
// ─────────────────────────────────────────────────────────────────────────────

pub fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn bump_persist<K>(e: &Env, key: &K)
where
    K: soroban_sdk::TryIntoVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    if e.storage().persistent().has(key) {
        e.storage()
            .persistent()
            .extend_ttl(key, PERSIST_LIFETIME_THRESHOLD, PERSIST_BUMP_AMOUNT);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance getters/setters
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}
pub fn put_admin(e: &Env, val: Address) {
    e.storage().instance().set(&DataKey::Admin, &val);
}

pub fn get_contract_version(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::ContractVersion)
        .unwrap_or(0)
}

pub fn put_contract_version(e: &Env, val: u32) {
    e.storage().instance().set(&DataKey::ContractVersion, &val);
}

pub fn get_storage_schema_version(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::StorageSchemaVersion)
        .unwrap_or(0)
}

pub fn put_storage_schema_version(e: &Env, val: u32) {
    e.storage()
        .instance()
        .set(&DataKey::StorageSchemaVersion, &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Granular RBAC helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns `true` when `addr` has been granted `role` in instance storage.
pub fn get_role(e: &Env, addr: &Address, role: Role) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Role(addr.clone(), role))
        .unwrap_or(false)
}

/// Grant (`val = true`) or revoke (`val = false`) `role` for `addr`.
pub fn put_role(e: &Env, addr: Address, role: Role, val: bool) {
    if val {
        e.storage()
            .instance()
            .set(&DataKey::Role(addr, role), &true);
    } else {
        e.storage().instance().remove(&DataKey::Role(addr, role));
    }
}

// ─── Backward-compatible operator wrappers ───────────────────────────────────

/// Returns `true` when `addr` holds the `FullOperator` superrole.
pub fn get_operator(e: &Env, addr: &Address) -> bool {
    get_role(e, addr, Role::FullOperator)
}

/// Grant or revoke the `FullOperator` superrole for `addr`.
pub fn put_operator(e: &Env, addr: Address, val: bool) {
    put_role(e, addr, Role::FullOperator, val);
}

pub fn get_default_asset(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::DefaultAsset).unwrap()
}
pub fn put_default_asset(e: &Env, val: Address) {
    e.storage().instance().set(&DataKey::DefaultAsset, &val);
}

pub fn get_default_zkme_verifier(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::DefaultZkmeVerifier)
        .unwrap()
}
pub fn put_default_zkme_verifier(e: &Env, val: Address) {
    e.storage()
        .instance()
        .set(&DataKey::DefaultZkmeVerifier, &val);
}

pub fn get_default_cooperator(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::DefaultCooperator)
        .unwrap()
}
pub fn put_default_cooperator(e: &Env, val: Address) {
    e.storage()
        .instance()
        .set(&DataKey::DefaultCooperator, &val);
}

pub fn get_vault_wasm_hash(e: &Env) -> BytesN<32> {
    e.storage().instance().get(&DataKey::VaultWasmHash).unwrap()
}
pub fn put_vault_wasm_hash(e: &Env, val: BytesN<32>) {
    e.storage().instance().set(&DataKey::VaultWasmHash, &val);
}

pub fn get_aggregator_vault(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::AggregatorVault)
}
#[allow(dead_code)]
pub fn put_aggregator_vault(e: &Env, val: Address) {
    e.storage().instance().set(&DataKey::AggregatorVault, &val);
}

pub fn get_default_fee_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::DefaultFeeBps)
        .unwrap_or(200)
}
pub fn put_default_fee_bps(e: &Env, val: u32) {
    e.storage().instance().set(&DataKey::DefaultFeeBps, &val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault indexing (Persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_vault_count(e: &Env) -> u32 {
    e.storage()
        .persistent()
        .get(&DataKey::VaultCount)
        .unwrap_or(0)
}

pub fn put_vault_count(e: &Env, val: u32) {
    e.storage().persistent().set(&DataKey::VaultCount, &val);
    bump_persist(e, &DataKey::VaultCount);
}

pub fn register_vault(e: &Env, vault: Address) {
    let count = get_vault_count(e);
    let key = DataKey::VaultAtIndex(count);
    e.storage().persistent().set(&key, &vault);
    bump_persist(e, &key);
    put_vault_count(e, count + 1);
}

pub fn unregister_vault(e: &Env, vault: Address) {
    let count = get_vault_count(e);
    if count == 0 {
        return;
    }

    let mut found_index: Option<u32> = None;
    for i in 0..count {
        if let Some(v) = get_vault_at_index(e, i) {
            if v == vault {
                found_index = Some(i);
                break;
            }
        }
    }

    if let Some(index) = found_index {
        let last_index = count - 1;
        if index != last_index {
            // Swap: move the last element to the position of the element being removed
            if let Some(last_vault) = get_vault_at_index(e, last_index) {
                let key = DataKey::VaultAtIndex(index);
                e.storage().persistent().set(&key, &last_vault);
                bump_persist(e, &key);
            }
        }
        // Pop: remove the last element and decrement the count
        e.storage()
            .persistent()
            .remove(&DataKey::VaultAtIndex(last_index));
        put_vault_count(e, last_index);
    }
}

pub fn get_vault_at_index(e: &Env, index: u32) -> Option<Address> {
    e.storage().persistent().get(&DataKey::VaultAtIndex(index))
}

pub fn get_vault_deploy_counter(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::VaultDeployCounter)
        .unwrap_or(0)
}

pub fn increment_vault_deploy_counter(e: &Env) -> u32 {
    let count = get_vault_deploy_counter(e) + 1;
    e.storage()
        .instance()
        .set(&DataKey::VaultDeployCounter, &count);
    count
}

pub fn get_vault_by_deploy_id(e: &Env, id: u32) -> Option<Address> {
    e.storage().persistent().get(&DataKey::VaultByDeployId(id))
}

pub fn put_vault_by_deploy_id(e: &Env, id: u32, vault: &Address) {
    let key = DataKey::VaultByDeployId(id);
    e.storage().persistent().set(&key, vault);
    bump_persist(e, &key);
}

// ─────────────────────────────────────────────────────────────────────────────
// VaultInfo (Persistent, keyed by vault address)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_vault_info(e: &Env, vault: &Address) -> Option<VaultInfo> {
    e.storage()
        .persistent()
        .get(&DataKey::VaultInfo(vault.clone()))
}

pub fn put_vault_info(e: &Env, vault: &Address, info: VaultInfo) {
    let key = DataKey::VaultInfo(vault.clone());
    e.storage().persistent().set(&key, &info);
    bump_persist(e, &key);
}

/// Delete the persistent VaultInfo entry for the given vault address.
pub fn delete_vault_info(e: &Env, vault: &Address) {
    e.storage()
        .persistent()
        .remove(&DataKey::VaultInfo(vault.clone()));
}

pub fn get_vaults_by_asset(e: &Env, asset: &Address) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::VaultsByAsset(asset.clone()))
        .unwrap_or_else(|| vec![e])
}

pub fn push_vaults_by_asset(e: &Env, asset: &Address, vault: Address) {
    let mut vaults = get_vaults_by_asset(e, asset);
    vaults.push_back(vault);
    e.storage()
        .persistent()
        .set(&DataKey::VaultsByAsset(asset.clone()), &vaults);
    bump_persist(e, &DataKey::VaultsByAsset(asset.clone()));
}

pub fn remove_from_vaults_by_asset(e: &Env, asset: &Address, vault: &Address) {
    let vaults = get_vaults_by_asset(e, asset);
    let mut updated: Vec<Address> = Vec::new(e);
    for i in 0..vaults.len() {
        let addr = vaults.get(i).unwrap();
        if addr != *vault {
            updated.push_back(addr);
        }
    }
    e.storage()
        .persistent()
        .set(&DataKey::VaultsByAsset(asset.clone()), &updated);
    bump_persist(e, &DataKey::VaultsByAsset(asset.clone()));
}
