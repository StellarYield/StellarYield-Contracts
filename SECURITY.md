# Security overview

This document supports **professional security audits** and internal review by stating **invariants**, **trust assumptions**, **known risks**, **attack surface**, and **external dependencies** for the StellarYield Soroban contracts (`single_rwa_vault`, `vault_factory`).

Formal notation uses standard math; `∀` denotes “for all,” `Σ` sum over all users/epochs where defined.

---

## 1. Invariants

These properties are **intended to hold** whenever the contract state is consistent. Violations indicate bugs or malicious state transitions.

### INV-1 — Share conservation (balances + escrow)

Let `balance(u)` be the share token balance in storage for user `u`, and `escrow(u)` escrowed shares. Let `S = total_supply`.

```
Σ_u balance(u) + Σ_u escrow(u) = S
```

*Rationale:* `_mint` / `_burn` adjust `balance` and `S` together; early redemption moves shares into escrow without burning until `process_early_redemption`, which reduces `escrow`, `S`, and `total_deposited` consistently.

### INV-2 — ERC-4626 share vs total supply (wallet balances only)

If `escrow(u) = 0` for all `u`, then `Σ_u balance(u) = S`.

### INV-3 — Yield accounting (global)

Let `Y` = `total_yield_distributed` (cumulative yield injected by the operator). Let `C_u` = `total_yield_claimed(u)` (cumulative claimed by `u`). Unclaimed yield is computed from epochs, not stored as a single global “pending” pool.

```
Σ_u C_u ≤ Y
```

(Equality holds in the idealized model without rounding loss; **strict inequality** may occur with rounding or partial epochs.)

### INV-4 — Epoch snapshot at distribution

When epoch `e` is created in `distribute_yield`, let `T_e` = `epoch_total_shares(e)` recorded at that moment.

```
T_e = S_at_distribution_e
```

where `S_at_distribution_e` is `total_supply` immediately before the epoch record is written (see `put_epoch_total_shares`).

### INV-5 — Claimed epoch implies no pending yield for that epoch

```
has_claimed_epoch(u, e) ⇒ pending_yield_for_epoch(u, e) = 0
```

(Enforced by `pending_yield_for_epoch` early return when `get_has_claimed_epoch` is true.)

### INV-6 — Solvency (accounting vs assets)

Let `A` = `total_assets()` = `total_deposited` (vault’s accounting of underlying units). Let `P` be the sum of principal obligations implied by `total_deposited` net of yield semantics; let `Π` be aggregate **unclaimed** yield entitlement implied by epoch math. Intuitively:

```
A ≥ Π + (principal obligations)
```

*Audit note:* State this precisely against `total_deposited` updates on deposit, withdraw, redeem, yield distribution, and fees. **Token balance** of the vault should not be less than what `transfer_asset_from_vault` would need to satisfy all claims under honest execution.

### INV-7 — Vault state DAG (no illegal regressions)

`vault_state` ∈ { `Funding`, `Active`, `Matured`, `Closed`, `Cancelled` } with transitions:

- `Funding` → `Active` | `Cancelled`
- `Active` → `Matured`
- `Matured` → `Closed`

No transitions from `Closed` or `Cancelled` to live states.

### INV-8 — Active vault has economic participation (informal)

When `vault_state == Active`, the protocol expects `S > 0` under normal operation (otherwise the vault is degenerate). **Edge case:** `S == 0` while `Active` may be transient; auditors should verify guards on `distribute_yield`, `activate_vault`, etc.

---

## 2. Trust assumptions

| Role / component | Trust | Notes |
|------------------|-------|--------|
| **Admin** | High privilege | Can change admin, blacklist, pause, emergency paths, KYC settings, funding targets. **Assumed honest** for correctness; **key compromise** must be modeled as full protocol compromise for vaults under that admin. |
| **Operator** | Operational | Can distribute yield, activate, maturity ops, early redemption processing, fee knobs, **pause** (where applicable). **Cannot** arbitrarily move assets without going through defined contract logic (auditors: verify `require_operator` / `require_admin` on each path). |
| **zkMe verifier** | KYC oracle | `is_kyc_verified` defers to `ZkmeVerifyClient`. **Trusted** for KYC correctness; **collusion** with users is out of scope unless threat model says otherwise. |
| **Cooperator** | zkMe parameter | Passed to verifier client; trusted as part of zkMe integration. |
| **Underlying asset (SAC)** | Token contract | **Assumed** compliant Stellar Asset Contract (SEP-41 style) behavior: transfers, balances, no fee-on-transfer surprises unless documented. |
| **Deployer / factory** | Deployment | Factory deploys vault WASM; operators configure defaults. Trust in **correct WASM hash** and **constructor params**. |

---

## 3. Known issues / accepted risks

See **`ISSUES.md`** for tracked items. Summary:

| Ref | Risk level | Mitigation strategy |
|-----|------------|---------------------|
| **K1** | Medium | Rounding documented; preview guards; integrator UX for dust. |
| **K2** | High (if asset evil) | **Asset allowlist**; review SAC; monitor anomalies. |
| **K3** | Medium | Verifier contract upgrade path; operational monitoring. |
| **K4** | Critical | Multisig, hardware keys, incident playbooks. |
| **K5** | Low–Medium | CI, pinned toolchain, re-run tests on network upgrades. |

Add GitHub issue links when filed.

---

## 4. Attack surface map

Categorized by **maximum impact** if the function were flawed or mis-authorized. **Every** `pub fn` entry point on the two main contracts is listed.

### Critical — moves underlying asset or principal

| Contract | Function | Notes |
|----------|----------|--------|
| `single_rwa_vault` | `deposit`, `mint`, `withdraw`, `redeem`, `redeem_at_maturity` | User flows; ERC-4626 rounding. |
| `single_rwa_vault` | `distribute_yield` | Pulls yield into vault. |
| `single_rwa_vault` | `claim_yield`, `claim_yield_for_epoch` | Outbound asset transfer. |
| `single_rwa_vault` | `refund` | Cancelled funding path. |
| `single_rwa_vault` | `emergency_withdraw` | Admin drains assets to recipient. |
| `single_rwa_vault` | `process_early_redemption` | Outbound to user (fee stays in vault). |
| `vault_factory` | `create_single_rwa_vault`, `create_single_rwa_vault_full`, `batch_create_vaults` | Deploys new vault instances (indirect asset risk via new deployments). |

### High — access control & registry authority

| Contract | Function | Notes |
|----------|----------|--------|
| `single_rwa_vault` | `transfer_admin`, `set_operator`, `set_*` (ZK, blacklist, pause, limits, fees, funding target, maturity) | Privileged. |
| `single_rwa_vault` | `process_early_redemption`, `reject_early_redemption` | Operator. |
| `vault_factory` | `transfer_admin`, `set_operator`, `set_defaults`, `set_vault_wasm_hash`, `remove_vault`, `set_vault_status` | Factory admin/operator. |

### Medium — configuration & lifecycle (no direct user asset move in one step)

| Contract | Function | Notes |
|----------|----------|--------|
| `single_rwa_vault` | `activate_vault`, `mature_vault`, `close_vault`, `cancel_funding`, `set_maturity_date`, `set_deposit_limits`, `set_early_redemption_fee`, `set_funding_target`, `set_transfer_requires_kyc`, `pause`, `unpause` | State and parameters. |
| `single_rwa_vault` | `request_early_redemption`, `cancel_early_redemption` | Escrow state. |
| `vault_factory` | `create_aggregator_vault` | Currently unsupported (panics); still an entry point. |

### Low — views & previews (information disclosure / simulation only)

| Contract | Function | Notes |
|----------|----------|--------|
| `single_rwa_vault` | `get_rwa_*`, `preview_*`, `max_*`, `pending_*`, `total_*`, `vault_state`, `balance`, `allowance`, `decimals`, `name`, `symbol`, `asset`, `*` getters | No state change; **privacy**: on-chain data is public. |
| `vault_factory` | `get_*`, `is_*`, `aggregator_vault`, `admin`, `default_*`, paginated lists | Registry read. |

### Share token (same contract) — SEP-41

| Category | Function |
|----------|----------|
| Medium–High | `transfer`, `transfer_from`, `approve`, `burn`, `burn_from` (auth + allowance rules) |
| Low | `allowance`, `balance`, `escrowed_balance`, `decimals`, `name`, `symbol`, `total_supply` |

---

## 5. External dependencies

| Dependency | Usage | Trust level |
|------------|--------|--------------|
| `token::Client` (underlying asset) | Deposits, withdrawals, yield | **Trusted** — standard SAC assumed. |
| `ZkmeVerifyClient` | `has_approved` for KYC | **Trusted** — see K3. |
| **Future** cross-contract calls | N/A | Document any new client here before release. |

### Appendix — complete `pub fn` entry points (audit inventory)

**`vault_factory`:** `__constructor`, `create_single_rwa_vault`, `create_single_rwa_vault_full`, `batch_create_vaults`, `create_aggregator_vault`, `remove_vault`, `set_vault_status`, `get_all_vaults`, `get_single_rwa_vaults`, `get_vault_info`, `is_registered_vault`, `get_vault_count`, `get_active_vaults`, `get_vaults_by_asset`, `get_vaults_paginated`, `get_active_vaults_paginated`, `aggregator_vault`, `transfer_admin`, `set_operator`, `set_defaults`, `set_vault_wasm_hash`, `admin`, `is_operator`, `default_asset`, `default_zkme_verifier`, `default_cooperator`.

**`single_rwa_vault`:** `__constructor`, `get_rwa_details`, `rwa_name`, `rwa_symbol`, `rwa_document_uri`, `rwa_category`, `is_kyc_verified`, `zkme_verifier`, `cooperator`, `set_zkme_verifier`, `set_cooperator`, `deposit`, `mint`, `withdraw`, `redeem`, `preview_deposit`, `preview_mint`, `preview_withdraw`, `preview_redeem`, `redemption_request`, `max_deposit`, `max_mint`, `max_withdraw`, `max_redeem`, `total_assets`, `distribute_yield`, `claim_yield`, `claim_yield_for_epoch`, `pending_yield`, `pending_yield_for_epoch`, `current_epoch`, `epoch_yield`, `total_yield_distributed`, `total_yield_claimed`, `vault_state`, `activate_vault`, `cancel_funding`, `refund`, `funding_deadline`, `mature_vault`, `close_vault`, `set_maturity_date`, `maturity_date`, `funding_target`, `is_funding_target_met`, `time_to_maturity`, `min_deposit`, `max_deposit_per_user`, `user_deposited`, `set_deposit_limits`, `redeem_at_maturity`, `request_early_redemption`, `process_early_redemption`, `cancel_early_redemption`, `reject_early_redemption`, `early_redemption_fee_bps`, `set_early_redemption_fee`, `admin`, `is_operator`, `set_operator`, `transfer_admin`, `set_blacklisted`, `is_blacklisted`, `transfer_requires_kyc`, `set_transfer_requires_kyc`, `pause`, `unpause`, `paused`, `emergency_withdraw`, `asset`, `current_apy`, `expected_apy`, `set_funding_target`, `allowance`, `approve`, `balance`, `escrowed_balance`, `transfer`, `transfer_from`, `burn`, `burn_from`, `decimals`, `name`, `symbol`, `total_supply`.

*(Excludes internal test-only modules in the same crate.)*

---

## Pre-audit checklist

- [ ] Invariants reviewed against latest `main` branch.
- [ ] `ISSUES.md` updated with current known risks.
- [ ] **Reviewer:** `________________` (contributor) **Date:** `________`
- [ ] External audit scope includes `single_rwa_vault` + `vault_factory` + SDK if applicable.
