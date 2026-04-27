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

The protocol follows Stellar best practices for storage tiering to balance cost and durability.

| Storage tier | Description | TTL Behavior |
|---|---|---|
| **Instance** | Global config, vault state, counters. | Shared lifetime; bumped by contract logic. |
| **Persistent** | Per-user balances, allowances, snapshots. | Per-entry lifetime; bumped on user interaction. |

### Storage key map (DataKey)

| Key | Tier | Description |
|---|---|---|
| `Admin` | Instance | Primary contract administrator address. |
| `Asset` | Instance | Underlying stable asset address (e.g. USDC). |
| `VaultSt` | Instance | Current lifecycle state (`Funding`, `Active`, `Matured`, `Closed`). |
| `TotSup` | Instance | Total supply of vault shares. |
| `TotDep` | Instance | Total deposited principal (excluding yield). |
| `CurEpoch` | Instance | Current epoch counter. |
| `Balance(Addr)` | Persistent | User share balance. |
| `Allowance(Owner, Spender)` | Persistent | User share allowance (with expiry). |
| `UsrDep(Addr)` | Persistent | Total principal deposited by a specific user. |
| `EpYield(u32)` | Instance | Total yield distributed in a specific epoch. |
| `EpTotShr(u32)` | Instance | Total share supply snapshotted at epoch distribution. |
| `Role(Addr, Role)` | Instance | Granular RBAC role assignment. |
| `Blacklst(Addr)` | Persistent | Compliance blacklist status. |

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

## Error catalog

This section documents all error codes returned by the contracts. Integrators can use these codes to display actionable error messages to users.

### `single_rwa_vault` errors

| Code | Error Variant | Trigger Condition | Remediation |
|---|---|---|---|
| 1 | `NotKYCVerified` | User has not completed KYC verification | Complete KYC verification through zkMe before attempting deposits |
| 2 | `ZKMEVerifierNotSet` | zkMe verifier contract address is not configured | Admin must set the zkMe verifier address via `set_zkme_verifier` |
| 3 | `NotOperator` | Caller lacks operator privileges | Request operator role from admin or use an authorized operator account |
| 4 | `NotAdmin` | Caller is not the contract admin | Use the admin account for this operation |
| 5 | `InvalidVaultState` | Operation not allowed in current vault state | Check vault state and wait for appropriate lifecycle transition |
| 6 | `BelowMinimumDeposit` | Deposit amount is below the minimum threshold | Increase deposit amount to meet or exceed `min_deposit` |
| 7 | `ExceedsMaximumDeposit` | Deposit would exceed per-user deposit limit | Reduce deposit amount to stay within `max_deposit_per_user` limit |
| 8 | `NotMatured` | Operation requires vault to be in Matured state | Wait until maturity date is reached |
| 9 | `NoYieldToClaim` | No unclaimed yield available for user | Wait for yield distribution or verify you have shares during yield epochs |
| 10 | `FundingTargetNotMet` | Vault cannot activate without meeting funding target | Wait for more deposits or admin may adjust funding target |
| 11 | `VaultPaused` | Vault operations are paused | Wait for admin/operator to unpause the vault |
| 12 | `ZeroAddress` | Address parameter is invalid (zero-equivalent) | Provide a valid non-zero address |
| 13 | `ZeroAmount` | Amount parameter is zero or negative | Provide a positive non-zero amount |
| 14 | `AddressBlacklisted` | Address is on the compliance blacklist | Contact compliance officer to resolve blacklist status |
| 15 | `Reentrant` | Reentrancy detected during guarded operation | This is a security error; contact support if encountered |
| 16 | `FundingDeadlinePassed` | Funding deadline has expired | Vault can no longer be activated; request refund if applicable |
| 17 | `FundingDeadlineNotPassed` | Funding deadline has not yet expired | Wait until deadline passes before canceling funding |
| 18 | `NoSharesToRefund` | User has no shares to refund | Only users with shares can request refunds during canceled funding |
| 19 | `InsufficientAllowance` | Spender allowance is too low | Increase allowance via `approve` before attempting transfer |
| 20 | `InsufficientBalance` | Account balance is too low | Ensure sufficient share balance before attempting operation |
| 21 | `AlreadyProcessed` | Operation has already been completed | This request has already been processed and cannot be repeated |
| 22 | `FeeTooHigh` | Requested fee exceeds maximum allowed | Reduce fee to 10% (1000 basis points) or below |
| 23 | `AggregatorNotSupported` | Price aggregator feature is not available | Use direct pricing methods instead |
| 24 | `InvalidRedemptionRequest` | Redemption request ID is invalid or not found | Verify the redemption request ID is correct |
| 25 | `NotSupported` | Operation or feature is not supported | Use alternative supported operations |
| 26 | `InvalidInitParams` | Constructor parameters are invalid | Review and correct initialization parameters |
| 27 | `VaultNotEmpty` | Vault cannot be closed while it contains assets/shares | Ensure all shares are redeemed before closing vault |
| 28 | `InvalidEpochRange` | Epoch range is invalid (zero start, start > end, or > 50) | Provide valid epoch range with start ≥ 1, start ≤ end, and range ≤ 50 |
| 29 | `NotInEmergency` | Operation requires vault to be in Emergency state | This operation is only available during emergency mode |
| 30 | `AlreadyClaimedEmergency` | User has already claimed emergency distribution | Emergency distribution can only be claimed once per user |
| 31 | `MigrationRequired` | Storage schema is outdated | Admin must call `migrate()` to update storage schema |
| 32 | `BurnRequiresYieldClaim` | Pending yield must be claimed before burning shares | Call `claim_yield()` before attempting to burn shares |
| 33 | `InvalidDepositLimits` | Deposit limit configuration is invalid | Ensure min_deposit ≤ max_deposit_per_user |
| 34 | `TimelockActionNotFound` | Timelock action ID does not exist | Verify the timelock action ID is correct |
| 35 | `TimelockDelayNotPassed` | Timelock delay period has not elapsed | Wait until the timelock delay period expires |
| 36 | `TimelockActionAlreadyExecuted` | Timelock action has already been executed | This action has already been completed |
| 37 | `TimelockActionCancelled` | Timelock action has been cancelled | This action was cancelled and cannot be executed |
| 38 | `TimelockAdminOnly` | Only admin can perform timelock operations | Use the admin account for timelock operations |
| 39 | `NotEmergencySigner` | Caller is not in the emergency signers list | Only designated emergency signers can perform this operation |
| 40 | `ProposalNotFound` | Emergency proposal does not exist | Verify the proposal ID is correct |
| 41 | `ProposalExpired` | Emergency proposal has expired (>24h) | Create a new emergency proposal |
| 42 | `ProposalAlreadyExecuted` | Emergency proposal has already been executed | This proposal has already been completed |
| 43 | `ThresholdNotMet` | Approval threshold has not been reached | Wait for more signers to approve the proposal |
| 44 | `AlreadyApproved` | Signer has already approved this proposal | Each signer can only approve once |
| 45 | `InvalidThreshold` | Threshold must be ≥ 1 and ≤ number of signers | Provide a valid threshold value |
| 46 | `FundingTargetExceeded` | Deposit would exceed funding target | Reduce deposit amount to stay within funding target |
| 47 | `PreviewZeroShares` | Amount converts to zero shares | Increase amount to receive at least one share |
| 48 | `PreviewZeroAssets` | Shares convert to zero assets | Increase shares to receive at least one asset unit |
| 49 | `TransferExemptionLimitExceeded` | Too many transfer-exempt addresses configured | Maximum 50 transfer-exempt addresses allowed |
| 50 | `NoShareholders` | Cannot distribute yield when there are no shareholders | Wait for deposits before distributing yield |

### `vault_factory` errors

| Code | Error Variant | Trigger Condition | Remediation |
|---|---|---|---|
| 1 | `VaultAlreadyExists` | Vault with this identifier already exists | Use a different vault name or identifier |
| 2 | `VaultNotFound` | Vault address is not registered in factory | Verify the vault address is correct and registered |
| 3 | `NotAuthorized` | Caller lacks required permissions | Use an authorized admin or operator account |
| 4 | `VaultIsActive` | Cannot remove an active vault | Set vault to inactive via `set_vault_status` before removal |
| 5 | `NotSupported` | Operation is not supported | Use alternative supported operations |
| 6 | `InvalidInitParams` | Initialization parameters are invalid | Review and correct vault creation parameters |
| 7 | `BatchTooLarge` | Batch size exceeds maximum of 10 vaults | Reduce batch size to 10 or fewer vaults |
| 8 | `InvalidWasmHash` | WASM hash is invalid (all zeros) | Provide a valid WASM hash from contract upload |
| 9 | `MigrationRequired` | Storage schema is outdated | Admin must call `migrate()` to update storage schema |

---

## Contract function reference

### `single_rwa_vault`

#### Core operations

| Method | Mutability | Auth | Units | Description |
|---|---|---|---|---|
| `deposit` | Update | None* | Assets | Deposit assets, receive shares. *Requires KYC. |
| `mint` | Update | None* | Shares | Mint shares, pay assets. *Requires KYC. |
| `withdraw` | Update | None | Assets | Burn shares, withdraw assets. |
| `redeem` | Update | None | Shares | Burn shares, receive assets. |
| `redeem_at_maturity` | Update | None | Shares | Matured-state full redemption with auto-yield claim. |

#### Yield management

| Method | Mutability | Auth | Units | Description |
|---|---|---|---|---|
| `distribute_yield` | Update | Operator | Assets | Inject yield and start a new epoch. |
| `claim_yield` | Update | None | Assets | Claim all pending yield across all epochs. |
| `pending_yield` | View | None | Assets | Unclaimed yield amount for a user. |
| `share_price` | View | None | Assets | Current price of one share (scaled by decimals). |
| `epoch_yield` | View | None | Assets | Total yield distributed in a given epoch. |

#### Administration & Configuration

| Method | Mutability | Auth | Units | Description |
|---|---|---|---|---|
| `activate_vault` | Update | Operator | — | Transition `Funding → Active`. |
| `mature_vault` | Update | Operator | — | Transition `Active → Matured`. |
| `set_maturity_date` | Update | Operator | Seconds | Update the maturity timestamp. |
| `set_operator` | Update | Admin | — | Grant or revoke operator role. |
| `transfer_admin` | Update | Admin | — | Transfer primary admin role. |
| `pause / unpause` | Update | Operator | — | Halt or resume vault operations. |
| `version` | View | None | — | Semantic contract version. |

### `vault_factory`

| Method | Mutability | Auth | Units | Description |
|---|---|---|---|---|
| `create_single_rwa_vault`| Update | Operator | — | Deploy a new vault contract. |
| `batch_create_vaults` | Update | Operator | — | Deploy multiple vaults in one TX (max 10). |
| `get_all_vaults` | View | None | — | List all registered vault addresses. |
| `get_vault_info` | View | None | — | Read metadata for a specific vault. |
| `set_vault_status` | Update | Admin | — | Activate/deactivate a vault in the registry. |
| `set_vault_wasm_hash` | Update | Admin | — | Update the WASM used for new deployments. |
| `version` | View | None | — | Factory contract version. |
