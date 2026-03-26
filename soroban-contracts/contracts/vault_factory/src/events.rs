//! Events for VaultFactory.

use soroban_sdk::{symbol_short, Address, Env, String};

use crate::types::VaultType;

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
