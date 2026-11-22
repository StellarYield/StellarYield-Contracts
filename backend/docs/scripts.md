# Backend Operator Scripts

This catalog documents all operator scripts in [`backend/src/scripts/`](../src/scripts/).

All scripts load `.env` via `import "dotenv/config"` and initialize the shared database pool (`src/db/index.ts`) and configuration (`src/config.ts`). Because `src/config.ts` validates `envSchema` on startup, every script requires `DATABASE_URL`, `STELLAR_RPC_URL` (must use `https://`), and `PORT` to be set in the environment or `.env` file, even if the script does not start an HTTP server or call Soroban RPC directly.

## Summary

| Script | npm Script | Modifies Data | Purpose |
| --- | --- | --- | --- |
| `backfill-cooperator.ts` | `npm run backfill-cooperator` | **Yes** (DB) | Backfills `vaults.cooperator_address` from on-chain state |
| `check-indexer.ts` | `npm run check-indexer` | No (read-only) | Checks indexer ledger lag against Soroban RPC |
| `export-data.ts` | `npm run export-data` | No (writes local JSON files) | Exports `vaults`, `user_vault_positions`, and `epochs` to JSON |
| `generate-api-key.ts` | `npm run generate-key` | **Yes** (DB) | Generates and stores a new `sky_`-prefixed API key |
| `import-from-factory.ts` | `npm run import-from-factory` | **Yes** (DB) | Backfills `vaults` from a factory contract's on-chain registry |
| `rebuild-positions.ts` | `npm run rebuild-positions` | **Yes** (DB, unless `--dry-run`) | Rebuilds `user_vault_positions` from `indexed_events` |
| `resync-vault.ts` | `npm run resync-vault` | **Yes** (DB) | Resynchronizes a vault's `total_assets` and `total_supply` from RPC |
| `rotate-api-key.ts` | `npm run rotate-api-key` | **Yes** (DB) | Rotates the newest active API key for a label with a grace period |

---

## `backfill-cooperator.ts`

- **Purpose:** Queries `vaults` where `cooperator_address IS NULL`, reads each vault's cooperator address from Soroban RPC (`readCooperator`), and updates `cooperator_address` and `updated_at` in PostgreSQL.
- **Modifies data:** **Yes** — updates rows in the `vaults` table.
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL.
  - `PORT` — Required by `envSchema` validation on startup.
  - Optional: `STELLAR_NETWORK` (default `testnet`), `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_RPC_TIMEOUT_MS`.
- **Arguments:** None.
- **Example command:**
  ```bash
  npm run backfill-cooperator
  # or directly:
  npx tsx src/scripts/backfill-cooperator.ts
  ```

---

## `check-indexer.ts`

- **Purpose:** Verifies indexer consistency by comparing the latest `last_ledger` in `indexer_state` against the current chain ledger from Soroban RPC (`getLatestLedger`). Exits with code `0` if lag is `<= 500` ledgers, or exits with code `1` and logs an alert if lag exceeds `500` ledgers or if either lookup fails.
- **Modifies data:** **No** — read-only against PostgreSQL and Soroban RPC.
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL.
  - `PORT` — Required by `envSchema` validation on startup.
- **Arguments:** None.
- **Example command:**
  ```bash
  npm run check-indexer
  # or directly:
  npx tsx src/scripts/check-indexer.ts
  ```

---

## `export-data.ts`

- **Purpose:** Exports all rows from `vaults`, `user_vault_positions`, and `epochs` into timestamped JSON files (`vaults.json`, `positions.json`, `epochs.json`) under `./exports/<YYYY-MM-DDTHH-mm-ss>/`.
- **Modifies data:** **No** (database is read-only; writes JSON files to the local `exports/` directory).
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL (required by `envSchema`).
  - `PORT` — Required by `envSchema` validation on startup.
- **Arguments:** None.
- **Example command:**
  ```bash
  npm run export-data
  # or directly:
  npx tsx src/scripts/export-data.ts
  ```

---

## `generate-api-key.ts`

- **Purpose:** Generates a new `sky_`-prefixed 32-byte random API key, hashes it with a per-key 16-byte random salt (`sha256(salt + plaintext)`), inserts the record into `api_keys` with label `generated-<timestamp>`, and prints the plaintext key to stdout.
- **Modifies data:** **Yes** — inserts a new row into the `api_keys` table.
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL (required by `envSchema`).
  - `PORT` — Required by `envSchema` validation on startup.
- **Arguments:**
  - `--role <admin|readonly>` *(optional, default: `admin`)* — Role assigned to the key.
  - `--expires-in <days>` *(optional, default: `null` / no expiration)* — Positive number of days until expiration.
  - `--allowed-methods <methods>` *(optional, default: `null` / all methods)* — Comma-separated HTTP methods (`GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`).
  - `--allowed-cidrs <cidrs>` *(optional, default: `null` / all CIDRs)* — Comma-separated CIDR ranges allowed to use the key.
  - `--allowed-contract-ids <ids>` *(optional, default: `null` / all contracts)* — Comma-separated Stellar contract IDs matching `/^C[A-Z2-7]{55}$/`.
- **Example command:**
  ```bash
  npm run generate-key -- --role readonly --expires-in 30 --allowed-methods GET,HEAD
  # or directly:
  npx tsx src/scripts/generate-api-key.ts --role admin --allowed-cidrs 10.0.0.0/8
  ```

---

## `import-from-factory.ts`

- **Purpose:** Backfills the `vaults` table from an existing factory contract's on-chain vault registry (`readFactoryVaults` and `readVaultFields`) and upserts each vault via `VaultService.upsertVault`. Intended for a fresh backend deployment against an existing factory.
- **Modifies data:** **Yes** — upserts rows in the `vaults` table.
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL.
  - `PORT` — Required by `envSchema` validation on startup.
  - Optional: `STELLAR_NETWORK` (default `testnet`), `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_RPC_TIMEOUT_MS`.
- **Arguments:**
  - `--factoryId <contractId>` *(required)* — Stellar contract ID of the vault factory.
- **Example command:**
  ```bash
  npm run import-from-factory -- --factoryId CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
  # or directly:
  npx tsx src/scripts/import-from-factory.ts --factoryId CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
  ```

---

## `rebuild-positions.ts`

- **Purpose:** Replays `deposit`, `withdraw`, `refunded`, and share `transfer` events from `indexed_events` in `(ledger_sequence, event_index)` order to recompute `share_balance`, `deposit_total`, and `last_updated_ledger`, then upserts them into `user_vault_positions` inside a transaction.
- **Modifies data:** **Yes** — upserts rows in `user_vault_positions` (unless `--dry-run` is passed, in which case it only logs the computed positions).
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL (required by `envSchema`).
  - `PORT` — Required by `envSchema` validation on startup.
- **Arguments:**
  - `--contractId <id>` *(optional)* — Limits the rebuild to events matching `data->>'contract_id' = <id>`. Omit to rebuild across all contracts.
  - `--dry-run` *(optional flag, default: `false`)* — Computes and logs positions without writing to PostgreSQL.
- **Example command:**
  ```bash
  npm run rebuild-positions -- --contractId CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM --dry-run
  # or directly:
  npx tsx src/scripts/rebuild-positions.ts
  ```

---

## `resync-vault.ts`

- **Purpose:** Fetches on-chain `total_assets` and `total_supply` for a single vault via Soroban RPC (`readTotalAssets`, `readTotalSupply`) and upserts them into the `vaults` table via `VaultService.upsertVault`.
- **Modifies data:** **Yes** — upserts the vault row in `vaults`.
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL.
  - `PORT` — Required by `envSchema` validation on startup.
  - Optional: `STELLAR_NETWORK` (default `testnet`), `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_RPC_TIMEOUT_MS`.
- **Arguments:**
  - `--contractId <id>` *(required)* — 56-character Stellar contract address matching `/^C[A-Z2-7]{55}$/`.
- **Example command:**
  ```bash
  npm run resync-vault -- --contractId CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
  # or directly:
  npx tsx src/scripts/resync-vault.ts --contractId CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
  ```

---

## `rotate-api-key.ts`

- **Purpose:** Rotates the newest active API key for a given `--label` under a PostgreSQL advisory transaction lock (`pg_advisory_xact_lock`). Creates a new key inheriting the old key's `role`, `expires_at`, `description`, `allowed_methods`, `allowed_cidrs`, `allowed_contract_ids`, and `rate_limit_override`, prints the new plaintext key to stdout, and sets the old key's `expires_at` to `LEAST(existing_expires_at, NOW() + graceDays)`. Rejects rotation if no active key exists for the label or if the label already has 2 active keys.
- **Modifies data:** **Yes** — inserts a new row and updates the previous active row in `api_keys`.
- **Required environment variables:**
  - `DATABASE_URL` — PostgreSQL connection string.
  - `STELLAR_RPC_URL` — HTTPS Soroban RPC endpoint URL (required by `envSchema`).
  - `PORT` — Required by `envSchema` validation on startup.
- **Arguments:**
  - `--label <label>` *(required)* — Label of the active API key to rotate.
  - `--grace-days <days>` *(optional, default: `7`)* — Non-negative integer number of days the old key remains valid.
- **Example command:**
  ```bash
  npm run rotate-api-key -- --label my-admin-key --grace-days 14
  # or directly:
  npx tsx src/scripts/rotate-api-key.ts --label my-admin-key --grace-days 14
  ```
