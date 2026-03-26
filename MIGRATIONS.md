# Vault Data Migration Guide

## Overview

When the `SingleRWAVault` contract code is upgraded, storage schemas may change. To prevent runtime failures, the contract tracks:

- `ContractVersion`: immutable code version set at deployment.
- `StorageSchemaVersion`: mutable version of the on-chain storage layout, updated by migrations.

## Migration Entry Point

```rust
pub fn migrate(e: &Env, caller: Address)
```

- **Authorization**: Admin-only.
- **Behavior**: No-op if already at latest schema; otherwise runs migration steps and updates `StorageSchemaVersion`.
- **Event**: Emits `DataMigrated(old_version, new_version)`.

## Version Guard

All state‑changing entry points (except `migrate`, `contract_version`, `storage_schema_version`, and admin functions) call `require_current_schema` at the start. If the stored schema differs from `CURRENT_SCHEMA_VERSION`, the transaction panics with `Error::MigrationRequired`.

## Adding a New Migration

1. Increment `CURRENT_SCHEMA_VERSION` in `src/migrations.rs`.
2. Implement a migration function, e.g. `migrate_v1_to_v2(e: &Env)`.
3. Call the new migration from `run_migrations` before updating the schema version.
4. Update this file with the new version details.

### Example (future v2)

```rust
// migrations.rs
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

pub fn run_migrations(e: &Env, from_version: u32) {
    if from_version < 2 {
        migrate_v1_to_v2(e);
    }
    // ... further versions
}
```

## Testing

- Deploy an old version, then upgrade to the new code.
- Call `migrate` as admin.
- Verify that new storage keys exist with defaults and that `StorageSchemaVersion` equals `CURRENT_SCHEMA_VERSION`.
- Test that normal operations now succeed (version guard passes).

## Factory

The `VaultFactory` follows the same pattern with its own `ContractVersion` and `StorageSchemaVersion`. Migrate the factory by calling its `migrate` function before deploying new vaults with an updated schema.
