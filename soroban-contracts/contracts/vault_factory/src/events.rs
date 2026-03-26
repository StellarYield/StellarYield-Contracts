//! Events for VaultFactory.

use soroban_sdk::{symbol_short, Address, BytesN, Env, String};

use crate::types::{Role, VaultType};

pub fn emit_vault_created(
    e: &Env,
    vault: Address,
    vault_type: VaultType,
    name: String,
    creator: Address,
) {
    e.events().publish(
        (symbol_short!("v_create"), vault),
        (vault_type, name, creator),
    );
}

pub fn emit_vault_status_changed(e: &Env, vault: Address, active: bool) {
    e.events()
        .publish((symbol_short!("v_status"), vault), active);
}

pub fn emit_admin_transferred(e: &Env, old: Address, new: Address) {
    e.events().publish((symbol_short!("adm_xfr"),), (old, new));
}

pub fn emit_operator_updated(e: &Env, operator: Address, status: bool) {
    e.events()
        .publish((symbol_short!("op_upd"), operator), status);
}

pub fn emit_defaults_updated(e: &Env, asset: Address, zkme_verifier: Address, cooperator: Address) {
    e.events().publish(
        (symbol_short!("def_upd"),),
        (asset, zkme_verifier, cooperator),
    );
}

/// Emitted when an inactive vault is removed from the factory registry.
pub fn emit_vault_removed(e: &Env, vault: Address, removed_by: Address) {
    e.events()
        .publish((symbol_short!("v_remove"), vault), removed_by);
}

/// Emitted when the vault WASM hash is updated by the admin.
pub fn emit_wasm_hash_updated(e: &Env, new_hash: BytesN<32>, updated_by: Address) {
    e.events()
        .publish((symbol_short!("wasm_upd"),), (new_hash, updated_by));
}

/// Emitted when the admin grants a role to an address.
pub fn emit_role_granted(e: &Env, addr: Address, role: Role) {
    e.events().publish((symbol_short!("role_grt"), addr), role);
}

/// Emitted by `migrate` — storage schema upgraded.
pub fn emit_data_migrated(e: &Env, old_version: u32, new_version: u32) {
    e.events()
        .publish((symbol_short!("data_mig"), old_version, new_version), ());
}

/// Emitted when the admin revokes a role from an address.
pub fn emit_role_revoked(e: &Env, addr: Address, role: Role) {
    e.events().publish((symbol_short!("role_rvk"), addr), role);
}
