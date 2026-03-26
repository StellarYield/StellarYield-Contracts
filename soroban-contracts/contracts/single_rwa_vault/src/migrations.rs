//! Data migration framework for SingleRWAVault.
//!
//! Provides version-to-version migration helpers that can be called from the
//! main `migrate` entry point. Each migration function is responsible for:
//! - Adding missing storage keys with sensible defaults
//! - Transforming or renaming keys if the schema changes
//! - Updating the storage schema version to the target version
//!
//! The current version is defined by CURRENT_SCHEMA_VERSION in lib.rs.

use soroban_sdk::Env;

use crate::storage::{bump_instance, put_storage_schema_version};

/// Current storage schema version of this contract code.
/// Increment this value when any breaking storage change is introduced.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Run all necessary migrations from the current stored version up to the latest.
/// Called by the public `migrate` function after admin checks.
pub fn run_migrations(e: &Env, from_version: u32) {
    if from_version < CURRENT_SCHEMA_VERSION {
        // In the future, add chained migration calls here, e.g.:
        // if from_version < 2 {
        //     migrate_v1_to_v2(e);
        // }
        // if from_version < 3 {
        //     migrate_v2_to_v3(e);
        // }
        // For now, we only have v1, so nothing to migrate.
        // Still, we update the schema version to mark migration as complete.
        put_storage_schema_version(e, CURRENT_SCHEMA_VERSION);
        bump_instance(e);
    }
}

// Example placeholder for a future v1 -> v2 migration.
// Uncomment and implement when schema version 2 is introduced.
/*
fn migrate_v1_to_v2(e: &Env) {
    // Example: add a new key with default value if missing
    if !e.storage().instance().has(&DataKey::NewFieldV2) {
        put_new_field_v2(e, default_value);
    }

    // Example: rename or transform data if needed
    // (not needed for v1->v2 in this example)
}
*/
