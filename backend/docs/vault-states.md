# Vault Lifecycle States

A vault's on-chain `VaultState` (`get_vault()` / `state` field) gates which contract
operations are permitted. The indexer mirrors this into `vaults.state` and re-emits it as
the `vault_state_changed` webhook (see [`webhooks.md`](./webhooks.md)).

## States

| State | Meaning |
|---|---|
| `Funding` | Raising capital toward `funding_target`; deposits accepted. |
| `Active` | Fully funded, RWA investment live, yield accrues. |
| `Matured` | Investment period ended; full redemptions enabled. |
| `Cancelled` | Funding deadline passed without meeting target; refunds available. |
| `Emergency` | Emergency mode; users claim a pro-rata share of remaining assets. |
| `Closed` | Terminal, admin-only archival state after `total_supply` reaches 0. |

## Transitions

| From | To | Trigger (contract fn) | Who | Webhook(s) fired |
|---|---|---|---|---|
| — | `Funding` | `__constructor` | — (vault deployment) | `vault_created` |
| `Funding` | `Active` | `activate_vault` | operator/admin, once funded | `vault_state_changed` |
| `Funding` | `Cancelled` | `cancel_funding` | LifecycleManager role, only after the funding deadline passes with target unmet | `vault_state_changed`, `cancel_funding`, `vault.cancelled` |
| `Active` | `Matured` | `mature_vault` | operator/admin | `vault_state_changed`, `vault.matured` |
| `Matured` | `Closed` | `close_vault` | admin, only when `total_supply == 0` | `vault_state_changed` |
| any state | `Emergency` | `emergency_enable_pro_rata` | emergency multisig signers | `vault_state_changed` |

`Cancelled`, `Emergency`, and `Closed` are terminal — no contract function transitions a
vault back out of them.

## Allowed operations per state

| Operation | Funding | Active | Matured | Cancelled | Emergency | Closed |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `deposit` / `mint` | ✅ (capped at `funding_target`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `withdraw` / `redeem` | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `redeem_at_maturity` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `request_early_redemption` / `process_early_redemption` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `distribute_yield` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `refund` | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `emergency_claim` | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

So: **a deposit is only allowed while the vault is in `Funding` or `Active`** — any other
state (including `Matured`, `Cancelled`, `Emergency`, `Closed`) rejects it via
`require_active_or_funding`. Read-only API endpoints (`GET /vaults/:contractId`, etc.) are
available regardless of state.
