# StellarYield — Soroban Smart Contracts

StellarYield is a Real World Asset (RWA) yield platform built natively on [Stellar](https://stellar.org) using [Soroban](https://soroban.stellar.org) smart contracts. It enables compliant, on-chain investment in tokenised real-world assets — such as Treasury Bills, corporate bonds, and real estate funds — with per-epoch yield distribution and full lifecycle management.

---

## Overview

The protocol is composed of two contracts:

### `single_rwa_vault`

Each deployed instance of this contract represents **one specific RWA investment**. Users deposit a stable asset (e.g. USDC) and receive vault shares proportional to their stake. The contract:

- Issues **SEP-41-compliant fungible share tokens** representing a user's position
- Enforces **zkMe KYC verification** before allowing deposits
- Tracks a **vault lifecycle**: `Funding → Active → Matured`
- Distributes **yield per epoch** — operators inject yield into the vault and users claim their share proportionally based on their share balance at the time of each epoch
- Supports **early redemption** via an operator-approved request flow with a configurable exit fee
- Allows **full redemption at maturity**, automatically settling any unclaimed yield
- Includes **per-user deposit limits** and an **emergency pause / withdraw** mechanism

### `vault_factory`

A registry and deployment factory for `single_rwa_vault` instances. It:

- Stores the `single_rwa_vault` WASM hash and deploys new vault contracts on demand using `e.deployer()`
- Maintains an on-chain registry of all deployed vaults with their metadata
- Supports **batch vault creation** in a single transaction
- Manages a shared set of **default configuration** values (asset, zkMe verifier, cooperator) inherited by every new vault
- Provides **admin and operator role management**

---

## Workspace layout

The Cargo workspace root is the **repository root** (`Cargo.toml` next to `soroban-contracts/`). From the clone root you can run:

```bash
cargo test -p vault_factory
```

```
StellarYield-Contracts/
├── Cargo.toml                          # workspace root (Soroban contracts)
└── soroban-contracts/
    ├── Makefile
    └── contracts/
        ├── single_rwa_vault/
        │   ├── Cargo.toml
        │   └── src/
        │       ├── lib.rs              – contract entry points & internal logic
        │       ├── types.rs            – InitParams, VaultState, RwaDetails, RedemptionRequest
        │       ├── storage.rs          – DataKey enum, typed getters/setters, TTL helpers
        │       ├── events.rs           – event emitters for every state change
        │       ├── errors.rs           – typed error codes (contracterror)
        │       └── token_interface.rs  – ZkmeVerifyClient cross-contract interface
        └── vault_factory/
            ├── Cargo.toml
            └── src/
                ├── lib.rs              – factory & registry logic
                ├── types.rs            – VaultInfo, VaultType, BatchVaultParams
                ├── storage.rs          – DataKey enum, typed getters/setters, TTL helpers
                ├── events.rs           – event emitters
                └── errors.rs           – typed error codes
```

---

## Architecture

```
VaultFactory
    ├── deploys ──▶ SingleRWA_Vault  (Treasury Bill A)
    ├── deploys ──▶ SingleRWA_Vault  (Corporate Bond B)
    └── deploys ──▶ SingleRWA_Vault  (Real Estate Fund C)
```

Each vault is an independent contract with its own share token, yield ledger, and lifecycle state. The factory only handles deployment and registration — it has no authority over a vault's funds once deployed.

---

## Vault lifecycle

```
Funding ──▶ Active ──▶ Matured ──▶ Closed
```

| State | Description |
|---|---|
| `Funding` | Accepting deposits until the funding target is reached |
| `Active` | RWA investment is live; operators distribute yield per epoch |
| `Matured` | Maturity date reached; users redeem principal + yield |
| `Closed` | Terminal state; all shares redeemed and vault wound down |

---

## Yield distribution model

Yield is distributed in discrete **epochs**. When an operator calls `distribute_yield`, the contract:

1. Pulls the yield amount from the operator into the vault
2. Records the epoch's total yield and the total share supply at that point in time
3. Snapshots each user's share balance lazily (on their next interaction)

A user's claimable yield for epoch `n` is:

$$\text{yield}_{\text{user}} = \frac{\text{shares}_{\text{user at epoch } n}}{\text{total shares at epoch } n} \times \text{epoch yield}_n$$

---

## Storage design

| Storage tier | Used for |
|---|---|
| **Instance** | Global config, vault state, epoch counters, operator registry — all tied to the contract's own TTL |
| **Persistent** | Per-user balances, allowances, yield claim flags, share snapshots — bumped on every interaction |

---

## Build

### Prerequisites

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Stellar CLI
cargo install --locked stellar-cli

# wasm32v1-none target (required by stellar contract build)
rustup target add wasm32v1-none
```

### Make targets

All developer workflows are standardised via `soroban-contracts/Makefile`:

| Target | Description |
|---|---|
| `make build` | Compile all contracts (`stellar contract build`) |
| `make test` | Run the full test suite (`cargo test --workspace`) |
| `make lint` | Run Clippy with `-D warnings` |
| `make fmt` | Check formatting (`cargo fmt --check`) |
| `make fmt-fix` | Auto-format source files |
| `make clean` | Remove build artifacts |
| `make optimize` | Run `stellar contract optimize` on compiled WASMs |
| `make wasm-size` | Report compiled WASM file sizes |
| `make bindings` | Generate TypeScript bindings via `stellar contract bindings typescript` |
| `make deploy-testnet` | Upload WASMs and deploy factory to testnet (interactive) |
| `make deploy-vault` | Create a vault through the deployed factory (interactive) |
| `make all` | Build → test → lint → fmt-check in sequence |
| `make ci` | Full CI pipeline (same as `all` with progress output) |
| `make help` | List all targets with descriptions |

```bash
cd soroban-contracts

# Quick start
make build        # compile
make test         # test
make all          # build + test + lint + fmt

# Full CI pipeline
make ci
```

Compiled `.wasm` files appear under the repository root in `target/wasm32v1-none/release/` (paths are the same when using `make` from `soroban-contracts/`, which runs Cargo from the workspace root).

---

## Deploy

### Interactive testnet deployment

Three shell scripts in `scripts/` cover the full deployment workflow.
They prompt for required parameters and save state to `soroban-contracts/.env.testnet`
so each subsequent step can pick up where the last left off.

```bash
# Step 1 — deploy the factory (uploads vault WASM, deploys VaultFactory)
./scripts/deploy-testnet.sh

# or via make (runs the same script)
cd soroban-contracts && make deploy-testnet
```

```bash
# Step 2 — create a vault through the factory
./scripts/create-vault.sh

# or via make
cd soroban-contracts && make deploy-vault
```

```bash
# Step 3 — deposit test tokens into a vault
./scripts/fund-vault.sh
```

Each script accepts the same parameters as environment variables, allowing
non-interactive use in CI:

```bash
FACTORY_ADDRESS=C... \
OPERATOR_ADDRESS=G... \
ASSET=C... \
VAULT_NAME="US Treasury 6-Month Bill" \
VAULT_SYMBOL=syUSTB \
RWA_NAME="US Treasury 6-Month Bill" \
RWA_SYMBOL=USTB6M \
RWA_DOCUMENT_URI="ipfs://bafybei..." \
MATURITY_DATE=1780000000 \
./scripts/create-vault.sh --non-interactive
```

### Manual deployment (raw CLI)

```bash
# 1. Upload the SingleRWA_Vault WASM and capture its hash
VAULT_HASH=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/single_rwa_vault.wasm \
  --source-account <YOUR_KEY> \
  --network testnet)

# 2. Deploy the VaultFactory
stellar contract deploy \
  --wasm target/wasm32v1-none/release/vault_factory.wasm \
  --source-account <YOUR_KEY> \
  --network testnet \
  -- \
  --admin        <ADMIN_ADDRESS> \
  --default_asset  <USDC_ADDRESS> \
  --zkme_verifier  <ZKME_ADDRESS> \
  --cooperator     <COOPERATOR_ADDRESS> \
  --vault_wasm_hash "$VAULT_HASH"

# 3. Create a vault through the factory
stellar contract invoke \
  --id <FACTORY_ADDRESS> \
  --source-account <YOUR_KEY> \
  --network testnet \
  -- create_single_rwa_vault \
  --caller      <OPERATOR_ADDRESS> \
  --asset       <USDC_ADDRESS> \
  --name        "US Treasury 6-Month Bill" \
  --symbol      "syUSTB" \
  --rwa_name    "US Treasury 6-Month Bill" \
  --rwa_symbol  "USTB6M" \
  --rwa_document_uri "ipfs://..." \
  --maturity_date 1780000000
```

---

## Contract function reference

### `single_rwa_vault`

#### Deposits & withdrawals

| Function | Auth | Description |
|---|---|---|
| `deposit(caller, assets, receiver)` | `caller` | Deposit assets; receive shares. Requires KYC. |
| `mint(caller, shares, receiver)` | `caller` | Mint exact shares; assets pulled from caller. Requires KYC. |
| `withdraw(caller, assets, receiver, owner)` | `caller` | Burn shares; withdraw exact asset amount. |
| `redeem(caller, shares, receiver, owner)` | `caller` | Burn exact shares; receive proportional assets. |
| `redeem_at_maturity(caller, shares, receiver, owner)` | `caller` | Matured-state full redemption; auto-claims pending yield. |

#### Yield

| Function | Auth | Description |
|---|---|---|
| `distribute_yield(caller, amount)` | Operator | Pull `amount` of asset into vault; open new epoch. |
| `claim_yield(caller)` | `caller` | Claim all unclaimed yield across all epochs. |
| `claim_yield_for_epoch(caller, epoch)` | `caller` | Claim yield for one specific epoch. |
| `pending_yield(user)` | — | Total unclaimed yield for `user`. |
| `pending_yield_for_epoch(user, epoch)` | — | Unclaimed yield for `user` in one epoch. |

#### Lifecycle

| Function | Auth | Description |
|---|---|---|
| `activate_vault(caller)` | Operator | Transition `Funding → Active`. Requires funding target met. |
| `mature_vault(caller)` | Operator | Transition `Active → Matured`. Requires `now ≥ maturity_date`. |
| `set_maturity_date(caller, timestamp)` | Operator | Update the maturity timestamp. |

#### Redemption

| Function | Auth | Description |
|---|---|---|
| `request_early_redemption(caller, shares)` | `caller` | Submit an early exit request. |
| `process_early_redemption(caller, request_id)` | Operator | Approve request; net assets transferred minus fee. |

#### Access control & emergency

| Function | Auth | Description |
|---|---|---|
| `set_operator(caller, operator, status)` | Admin | Grant or revoke operator role. |
| `transfer_admin(caller, new_admin)` | Admin | Transfer admin role. |
| `pause(caller, reason)` | Operator | Halt all state-changing operations. |
| `unpause(caller)` | Operator | Resume operations. |
| `emergency_withdraw(caller, recipient)` | Admin | Drain vault assets to `recipient` and pause. |
| `set_zkme_verifier(caller, verifier)` | Admin | Update the zkMe verifier contract. |
| `set_cooperator(caller, cooperator)` | Admin | Update the zkMe cooperator address. |

#### SEP-41 share token

| Function | Description |
|---|---|
| `balance(id)` | Share balance of `id` |
| `transfer(from, to, amount)` | Transfer shares |
| `transfer_from(spender, from, to, amount)` | Transfer shares via allowance |
| `approve(from, spender, amount, expiration_ledger)` | Set allowance |
| `allowance(from, spender)` | Read allowance |
| `burn(from, amount)` / `burn_from(spender, from, amount)` | Burn shares |
| `decimals / name / symbol / total_supply` | Token metadata |

---

### `vault_factory`

#### Vault creation

| Function | Auth | Description |
|---|---|---|
| `create_single_rwa_vault(caller, asset, name, symbol, …)` | Operator | Deploy a vault with minimal parameters. |
| `create_single_rwa_vault_full(caller, params)` | Operator | Deploy a fully configured vault via `CreateVaultParams`. |
| `batch_create_vaults(caller, params)` | Operator | Deploy multiple vaults in one transaction. |

#### Registry queries

| Function | Description |
|---|---|
| `get_all_vaults()` | All registered vault addresses |
| `get_single_rwa_vaults()` | Single-RWA vault addresses only |
| `get_active_vaults()` | Active (non-deactivated) vaults |
| `get_vault_info(vault)` | `VaultInfo` for a vault (`vault`, **`asset`** (underlying), `vault_type`, `name`, `symbol`, `active`, `created_at`) |
| `is_registered_vault(vault)` | Boolean registry check |
| `get_vault_count()` | Total number of registered vaults |

#### Admin

| Function | Auth | Description |
|---|---|---|
| `set_vault_status(caller, vault, active)` | Admin | Activate or deactivate a vault in the registry. |
| `set_defaults(caller, asset, zkme_verifier, cooperator)` | Admin | Update default settings for future vaults. |
| `set_vault_wasm_hash(caller, hash)` | Admin | Update the vault WASM hash used for deployment. |
| `set_operator(caller, operator, status)` | Admin | Grant or revoke operator role. |
| `transfer_admin(caller, new_admin)` | Admin | Transfer admin role. |
