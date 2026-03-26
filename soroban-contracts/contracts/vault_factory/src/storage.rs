//! Storage layer for VaultFactory.
//!
//! All vault registry data is Persistent (vault addresses must survive long term).
//! Global config is Instance.

use soroban_sdk::{contracttype, vec, Address, BytesN, Env, Vec};

use crate::types::VaultInfo;

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
    Operator(Address),
    DefaultAsset,
    DefaultZkmeVerifier,
    DefaultCooperator,
    VaultWasmHash,
    AggregatorVault,
    AllVaults,
    SingleRwaVaults,
    ActiveVaults,
    VaultInfo(Address),
    VaultCount,
    VaultDeployCounter,
    VaultsByAsset(Address),
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

pub fn get_operator(e: &Env, addr: &Address) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Operator(addr.clone()))
        .unwrap_or(false)
}
pub fn put_operator(e: &Env, addr: Address, val: bool) {
    if val {
        e.storage().instance().set(&DataKey::Operator(addr), &val);
    } else {
        e.storage().instance().remove(&DataKey::Operator(addr));
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Vault count counter (Instance — same lifetime as other global config)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_vault_count(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::VaultCount)
        .unwrap_or(0)
}

fn put_vault_count(e: &Env, val: u32) {
    e.storage().instance().set(&DataKey::VaultCount, &val);
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

// ─────────────────────────────────────────────────────────────────────────────
// Vault lists (Persistent)
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_all_vaults(e: &Env) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::AllVaults)
        .unwrap_or_else(|| vec![e])
}

pub fn push_all_vaults(e: &Env, addr: Address) {
    let mut vaults = get_all_vaults(e);
    vaults.push_back(addr);
    e.storage().persistent().set(&DataKey::AllVaults, &vaults);
    bump_persist(e, &DataKey::AllVaults);
    put_vault_count(e, get_vault_count(e) + 1);
}

pub fn get_single_rwa_vaults(e: &Env) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::SingleRwaVaults)
        .unwrap_or_else(|| vec![e])
}

pub fn push_single_rwa_vaults(e: &Env, addr: Address) {
    let mut vaults = get_single_rwa_vaults(e);
    vaults.push_back(addr);
    e.storage()
        .persistent()
        .set(&DataKey::SingleRwaVaults, &vaults);
    bump_persist(e, &DataKey::SingleRwaVaults);
}

pub fn get_active_vaults(e: &Env) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::ActiveVaults)
        .unwrap_or_else(|| vec![e])
}

pub fn push_active_vaults(e: &Env, addr: Address) {
    let mut vaults = get_active_vaults(e);
    vaults.push_back(addr);
    e.storage()
        .persistent()
        .set(&DataKey::ActiveVaults, &vaults);
    bump_persist(e, &DataKey::ActiveVaults);
}

pub fn remove_from_active_vaults(e: &Env, vault: &Address) {
    let vaults = get_active_vaults(e);
    let mut updated: Vec<Address> = Vec::new(e);
    for i in 0..vaults.len() {
        let addr = vaults.get(i).unwrap();
        if addr != *vault {
            updated.push_back(addr);
        }
    }
    e.storage()
        .persistent()
        .set(&DataKey::ActiveVaults, &updated);
    bump_persist(e, &DataKey::ActiveVaults);
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

/// Remove a vault address from the AllVaults list and decrement the counter.
pub fn remove_from_all_vaults(e: &Env, vault: &Address) {
    let vaults = get_all_vaults(e);
    let mut updated: Vec<Address> = Vec::new(e);
    for i in 0..vaults.len() {
        let addr = vaults.get(i).unwrap();
        if addr != *vault {
            updated.push_back(addr);
        }
    }
    e.storage().persistent().set(&DataKey::AllVaults, &updated);
    bump_persist(e, &DataKey::AllVaults);
    let count = get_vault_count(e);
    if count > 0 {
        put_vault_count(e, count - 1);
    }
}

/// Remove a vault address from the SingleRwaVaults list.
pub fn remove_from_single_rwa_vaults(e: &Env, vault: &Address) {
    let vaults = get_single_rwa_vaults(e);
    let mut updated: Vec<Address> = Vec::new(e);
    for i in 0..vaults.len() {
        let addr = vaults.get(i).unwrap();
        if addr != *vault {
            updated.push_back(addr);
        }
    }
    e.storage()
        .persistent()
        .set(&DataKey::SingleRwaVaults, &updated);
    bump_persist(e, &DataKey::SingleRwaVaults);
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
