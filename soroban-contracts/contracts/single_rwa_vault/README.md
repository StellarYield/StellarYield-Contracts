# single_rwa_vault

Each deployed instance of `single_rwa_vault` represents one real-world asset
investment, such as a Treasury bill fund, a corporate bond, or a real estate
fund. Investors deposit a stable asset (for example USDC) through a zkMe-verified
KYC gate and receive SEP-41 share tokens in proportion to their stake. The
vault moves through a lifecycle of `Funding`, `Active`, and `Matured`, with
`Cancelled`, `Closed`, and `Emergency` as end states. Operators distribute
yield per epoch, holders claim it against their share balance, and early
redemptions go through an operator-approved request flow with an exit fee. The
contract also provides per-user deposit limits, a timelock for critical admin
actions, and an emergency pause with multisig or pro-rata withdrawal paths.

## Module map

All paths are relative to `src/`.

| File | Purpose |
| --- | --- |
| `lib.rs` | Contract entry points and internal logic, including the timelock (`propose_action`, `execute_action`, `cancel_action`) and emergency functions. |
| `storage.rs` | Storage layer: typed getters and setters, TTL helpers, and the timelock delay and action records. |
| `math.rs` | Overflow-safe arithmetic (`mul_div` through `I256`) and the non-negative amount guard. |
| `events.rs` | Event emitters, one per state change. |
| `errors.rs` | Typed error codes (`#[contracterror]`). |
| `types.rs` | Shared types such as `InitParams`, `VaultState`, `ActionType`, and `TimelockAction`. |
| `token_interface.rs` | Cross-contract client for the zkMe verifier. |
| `migrations.rs` | Storage schema migration helpers. |
| `test_timelock_errors.rs` | Timelock error-path tests. Compiled and run. |
| `test_timelock.rs` | Timelock behaviour tests. Not declared in `lib.rs`, so it is currently not compiled or run. |

## Documentation

- [Timelock operator guide](../../../docs/timelock.md)
- [Emergency procedures runbook](../../../docs/emergency-procedures.md)
- [Contract error codes](../../../docs/contract-error-codes.md)
- [Roles (RBAC)](../../../docs/rbac-roles.md)

## Running the tests

The Cargo workspace root is the repository root, so run the tests from there:

```bash
cargo test -p single_rwa_vault
```
