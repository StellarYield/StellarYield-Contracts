//! Data migration framework for VaultFactory.

use soroban_sdk::Env;

use crate::storage::{bump_instance, put_storage_schema_version};

/// Current storage schema version of this contract code.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Run all necessary migrations from the current stored version up to the latest.
pub fn run_migrations(e: &Env, from_version: u32) {
    if from_version < CURRENT_SCHEMA_VERSION {
        // No-op for v1, but mark schema as up-to-date.
        put_storage_schema_version(e, CURRENT_SCHEMA_VERSION);
        bump_instance(e);
    }
}
