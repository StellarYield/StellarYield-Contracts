# RBAC Role Matrix

This document maps every role and special authorization check against the state-changing functions in [`single_rwa_vault`](../soroban-contracts/contracts/single_rwa_vault/src/lib.rs) and [`vault_factory`](../soroban-contracts/contracts/vault_factory/src/lib.rs).

## Role Hierarchy & Authorization Primitives

Both contracts define the same `Role` enum in `types.rs`:

- `Admin` — The contract administrator (`require_admin`). Always passes `require_admin` and every `require_role` check.
- `FullOperator` — Backward-compatible superrole (also toggled via `set_operator`). Passes every `require_role` check, including `require_operator_or_admin` in `vault_factory`, but does **not** pass `require_admin`.
- `YieldOperator` — Passes `require_role(..., Role::YieldOperator)` only.
- `LifecycleManager` — Passes `require_role(..., Role::LifecycleManager)` only.
- `ComplianceOfficer` — Passes `require_role(..., Role::ComplianceOfficer)` only.
- `TreasuryManager` — Passes `require_role(..., Role::TreasuryManager)` only.
- `EmergencySigner` (`single_rwa_vault` only) — Addresses configured via `set_emergency_signers` (`require_emergency_signer`). Independent of `Admin` and `Role` unless explicitly included in the signer list.

**Legend:**
- **Yes** — Allowed directly by the function's `require_*` check.
- **No** — Rejected (`NotAdmin`, `NotOperator`, `NotAuthorized`, or `NotEmergencySigner`).
- **Conditional** — Depends on vault state, timelock, pause state, or multi-sig configuration (see notes).

---

## `single_rwa_vault`

### Role-Gated & Privileged Functions

| Function | `Admin` | `FullOperator` | `YieldOperator` | `LifecycleManager` | `ComplianceOfficer` | `TreasuryManager` | `EmergencySigner` | Timelock / Special Condition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `set_rwa_details` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_rwa_document_uri` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_expected_apy` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_lock_up_period` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_max_investors` | Yes | No | No | No | No | No | No | `require_admin` |
| `grant_role` | Yes | No | No | No | No | No | No | `require_admin` |
| `revoke_role` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_operator` | Yes | No | No | No | No | No | No | `require_admin` (grants/revokes `FullOperator`) |
| `transfer_admin` | Conditional | No | No | No | No | No | No | `require_admin`; always panics with `TimelockAdminOnly` — must use `propose_action` |
| `propose_action` | Yes | No | No | No | No | No | No | `require_admin`; schedules action after `timelock_delay` |
| `execute_action` | Yes | No | No | No | No | No | No | `require_admin` + `timelock_delay` elapsed (`EmergencyWithdraw`, `TransferAdmin`, `Upgrade`, `WasmHashUpdate` currently panic with `NotSupported`) |
| `cancel_action` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_transfer_exempt` | Yes | No | No | No | No | No | No | `require_admin` |
| `unpause` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_emergency_signers` | Yes | No | No | No | No | No | No | `require_admin` |
| `emergency_enable_pro_rata` | Yes | No | No | No | No | No | No | `require_admin` |
| `migrate` | Yes | No | No | No | No | No | No | `require_admin` |
| `set_deposit_limits` | Yes | Conditional | No | No | No | No | No | `Funding`: `FullOperator` or `Admin`; `Active`: `Admin` only; other states: `InvalidVaultState` |
| `set_min_deposit` | Yes | Conditional | No | No | No | No | No | `Funding`: `FullOperator` or `Admin`; `Active`: `Admin` only; other states: `InvalidVaultState` |
| `set_max_deposit_per_user` | Yes | Conditional | No | No | No | No | No | `Funding`: `FullOperator` or `Admin`; `Active`: `Admin` only; other states: `InvalidVaultState` |
| `distribute_yield` | Yes | Yes | Yes | No | No | No | No | `require_role(..., YieldOperator)` |
| `resolve_yield_shortfall` | Yes | Yes | Yes | No | No | No | No | `require_role(..., YieldOperator)` |
| `activate_vault` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `cancel_funding` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `mature_vault` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `close_vault` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `set_maturity_date` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `process_early_redemption` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `reject_early_redemption` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `set_early_redemption_fee` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `set_yield_vesting_period` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `set_funding_target` | Yes | Yes | No | Yes | No | No | No | Delegates to `set_funding_target_with_reason` |
| `set_funding_target_with_reason` | Yes | Yes | No | Yes | No | No | No | `require_role(..., LifecycleManager)` |
| `set_zkme_verifier` | Yes | Yes | No | No | Yes | No | No | `require_role(..., ComplianceOfficer)` |
| `set_cooperator` | Yes | Yes | No | No | Yes | No | No | `require_role(..., ComplianceOfficer)` |
| `set_blacklisted` | Yes | Yes | No | No | Yes | No | No | `require_role(..., ComplianceOfficer)` |
| `set_transfer_requires_kyc` | Yes | Yes | No | No | Yes | No | No | `require_role(..., ComplianceOfficer)` |
| `pause` | Yes | Yes | No | No | No | Yes | No | `require_role(..., TreasuryManager)` |
| `set_freeze_flags` | Yes | Yes | No | No | No | Yes | No | `require_role(..., TreasuryManager)` |
| `emergency_withdraw` | Conditional | Conditional | No | No | No | Conditional | No | `require_role(..., TreasuryManager)`. Bypasses timelock only when vault is already paused (`TimelockAdminOnly` if unpaused). Disabled (`NotSupported`) when emergency multi-sig signers are configured. |
| `propose_emergency_withdraw` | No | No | No | No | No | No | Yes | `require_emergency_signer` |
| `approve_emergency_withdraw` | No | No | No | No | No | No | Yes | `require_emergency_signer` |
| `execute_emergency_withdraw` | No | No | No | No | No | No | Yes | `require_emergency_signer`; requires approvals >= `threshold` and proposal not expired |

### User & Token State-Changing Functions (No RBAC Role Required)

These functions are open to any caller passing `caller.require_auth()` and applicable vault state, KYC, blacklist, lock-up, and freeze checks:
- Vault operations: `deposit`, `mint`, `withdraw`, `redeem`, `claim_yield`, `claim_yield_for_epoch`, `refund`, `redeem_at_maturity`, `request_early_redemption`, `cancel_early_redemption`, `emergency_claim`.
- SEP-41 share token operations: `approve`, `transfer`, `transfer_from`, `burn`, `burn_from`.

---

## `vault_factory`

| Function | `Admin` | `FullOperator` | `YieldOperator` / `LifecycleManager` / `ComplianceOfficer` / `TreasuryManager` | Notes |
| --- | --- | --- | --- | --- |
| `migrate` | Yes | No | No | `require_admin` |
| `remove_vault` | Yes | No | No | `require_admin` |
| `set_vault_status` | Yes | No | No | `require_admin` |
| `transfer_admin` | Yes | No | No | `require_admin` |
| `grant_role` | Yes | No | No | `require_admin` |
| `revoke_role` | Yes | No | No | `require_admin` |
| `set_operator` | Yes | No | No | `require_admin` (grants/revokes `FullOperator`) |
| `set_defaults` | Yes | No | No | `require_admin` |
| `set_vault_wasm_hash` | Yes | No | No | `require_admin` |
| `create_single_rwa_vault` | Yes | Yes | No | `require_operator_or_admin` -> `require_role(..., FullOperator)` |
| `create_single_rwa_vault_full` | Yes | Yes | No | `require_operator_or_admin` -> `require_role(..., FullOperator)` |
| `create_single_rwa_vault_batch` | Yes | Yes | No | `require_operator_or_admin` -> `require_role(..., FullOperator)` |
| `batch_create_vaults` | Yes | Yes | No | `require_operator_or_admin` -> `require_role(..., FullOperator)` |
| `create_aggregator_vault` | No | No | No | Always panics with `NotSupported` |
