# SingleRWAVault — Resource Cost Benchmarks

This document tracks CPU instruction and memory cost for the `single_rwa_vault`
contract's hot-path entry points so regressions are visible in PRs.

The benchmarks are implemented as `#[ignore]` tests in
`contracts/single_rwa_vault/src/bench.rs` and emit `cpu=…` / `mem=…` lines via
`println!`. Numbers below are produced by running them in native Rust mode —
WASM execution will be **strictly more expensive** (per the soroban-sdk
docs: *"CPU instructions are likely to be underestimated when running Rust
code compared to running the WASM equivalent"*). Treat the numbers as
**relative** indicators, not absolute on-chain costs.

## Running

```bash
# Just the benchmarks, with output captured
cargo test --package single_rwa_vault --lib bench:: -- --ignored --nocapture

# The always-on regression check (runs in normal CI):
cargo test --package single_rwa_vault --lib bench::bench_deposit_within_cpu_budget
```

## Cost table (native Rust, soroban-sdk 22.0.11)

| Function                  | CPU instructions | Memory bytes |
| ------------------------- | ---------------: | -----------: |
| `deposit`                 |          362,082 |       87,149 |
| `withdraw`                |          520,917 |       95,888 |
| `transfer`                |          421,237 |       80,755 |
| `distribute_yield`        |          178,089 |       56,944 |
| `claim_yield` (1 epoch)   |          496,099 |      110,592 |
| `claim_yield` (10 epochs) |        2,267,007 |      405,432 |
| `claim_yield` (50 epochs) |       15,523,415 |    3,244,632 |
| `redeem_at_maturity`      |          530,046 |      100,617 |

Stellar Soroban's per-transaction CPU instruction budget is **100,000,000**.
Even at 50 epochs, native `claim_yield` consumes ~15.5% of that — the WASM
multiplier and per-user state growth are the real risk.

## Scaling observations

- **`claim_yield` is linear in epoch count.** From 1 → 10 → 50 epochs the cost
  grows ~4.6× → ~31×. The slope is **~310k CPU instructions per additional
  epoch**, dominated by the `update_user_snapshot` walk plus per-epoch
  `HasClaimedEpoch` writes. A single user accumulating ~250 unclaimed epochs
  natively would already approach the 80M-instruction alarm threshold; in
  WASM that ceiling will be hit much sooner.
- **`deposit`, `withdraw`, `transfer`, `redeem_at_maturity`** all sit in the
  300k–530k native CPU range and do not scale with epoch count for the
  caller. They scale weakly with the *number of unclaimed epochs* on the
  user's snapshot the first time the user touches the vault after a long
  break, via `update_user_snapshot`.
- **`distribute_yield`** is the cheapest entry point (~178k native CPU). It
  records a fixed set of instance-storage entries per epoch
  (`EpYield`, `EpTotShr`, `EpTimest`, and now `EpochTotalAssets` from #119)
  and does not iterate users.

## Identified bottlenecks and recommendations

1. **`update_user_snapshot` walks every unclaimed epoch.** The 50-epoch
   `claim_yield` shows the linear blow-up. Recommendations:
   - Batch the snapshot write — store a single "last interacted at epoch N
     with shares S" row instead of per-epoch `UsrShrEp` entries.
   - Cap `claim_yield` to a bounded epoch window (e.g. 64) and require users
     to call it again to drain the rest. Predictable per-call cost beats
     unpredictable big claims.
2. **`pending_yield` performs the same linear scan as `claim_yield`.** It is
   called as a *view* but is no cheaper than the write path. Either share
   the cursor logic so view and write produce the same bound, or document
   that view calls past ~128 epochs may exceed the simulator budget.
3. **`vault_factory::get_active_vaults` is O(n) with cross-contract calls.**
   Not measured here (different package), but flagged for parity: switching
   to an indexed list of active vaults would remove the per-vault probe.
4. **`bump_instance` on view functions:** verified — currently only invoked
   from state-mutating functions in this contract, so there is nothing to
   strip on the view side. Keep it that way; reviewers should reject any new
   `bump_instance` call on a `pub fn` that does not write storage.

## Regression guard

`bench::bench_deposit_within_cpu_budget` runs on every CI invocation
(it is *not* `#[ignore]`) and asserts that native `deposit` consumes fewer
than 80% of the Soroban per-transaction CPU budget (80,000,000 instructions).
Native execution is much cheaper than WASM, so this only catches dramatic
regressions — it is a smoke alarm, not a precise meter. Real budget-fit
verification should be done on testnet with `soroban contract invoke`
diagnostics or a soroban-cli simulation against a deployed WASM build.
