# Timelock Operator Guide

This guide covers the timelock in the `single_rwa_vault` contract: how an
admin proposes, waits, executes, and cancels a timelocked action, the delay
that applies, which actions can be proposed, and the error returned at each
step.

Source of truth:
- Entry points and checks: [`lib.rs`](../soroban-contracts/contracts/single_rwa_vault/src/lib.rs) (`propose_action`, `execute_action`, `cancel_action`, `get_timelock_action`)
- Action types and record: [`types.rs`](../soroban-contracts/contracts/single_rwa_vault/src/types.rs) (`ActionType`, `TimelockAction`)
- Storage: [`storage.rs`](../soroban-contracts/contracts/single_rwa_vault/src/storage.rs) (timelock delay and action records)
- Error codes: [`errors.rs`](../soroban-contracts/contracts/single_rwa_vault/src/errors.rs)
- Tests: `test_timelock_errors.rs` (compiled and run). `test_timelock.rs` exists in the same `src/` directory but is not declared in `lib.rs`, so it is not run.

---

## Current status: read this first

The timelock can **propose, cancel, and record** actions, but it **cannot
execute any action yet**.

- `execute_action` checks the action's state and the delay. Once those checks
  pass, it hits a `match` arm that reverts with `NotSupported` (25) for every
  `ActionType`. No action reaches a state change.
- `transfer_admin` on the vault reverts with `TimelockAdminOnly` (38) and
  tells the caller to use `propose_action` instead. The path that would
  complete the transfer is not implemented.
- The `executed` flag on a timelock action is never set to `true`, and no
  `ActionExecuted` event is emitted.

Until execution is implemented, do not treat a proposed action as a scheduled
change. Use the steps below to record intent and to cancel. Do not plan an
upgrade, admin change, or emergency withdrawal around the timelock.

---

## Delay

| Property | Value |
| --- | --- |
| Delay unit | Seconds, compared against the ledger timestamp |
| Default | `172800` seconds (48 hours) |
| Where it is set | `InitParams.timelock_delay` at deployment. `vault_factory` passes `172_800` by default. |
| Stored in | Instance storage, key `TlkDelay` |
| Can it change after deployment? | No. The contract has no setter. The only write is in `__constructor`. |
| Validated? | No. The constructor does not range-check `timelock_delay`, so `0` is accepted and gives no delay. Check the value in your deployment parameters before deploying. |

The fallback in `get_timelock_delay` (`172800`) only applies if the key is
missing. A deployed contract always has the key set by its constructor.

For an action proposed at ledger time `T`, the action becomes executable at
`executable_at = T + delay`. Execution is allowed when the ledger timestamp is
greater than or equal to `executable_at`.

---

## Actions that can be proposed

`propose_action` takes an `ActionType`. These are the four types the contract
defines:

| `ActionType` | Intended use | Current execution result |
| --- | --- | --- |
| `EmergencyWithdraw` | Withdraw vault assets through the timelock | `NotSupported` (25) |
| `TransferAdmin` | Change the admin address | `NotSupported` (25). The direct `transfer_admin` call returns `TimelockAdminOnly` (38). |
| `Upgrade` | Upgrade the contract code | `NotSupported` (25) |
| `WasmHashUpdate` | Change the stored WASM hash | `NotSupported` (25) |

`propose_action` also takes a `data: Bytes` payload. The contract stores it
unchanged and does not decode or validate it. Put the payload in the form the
future executor expects, and expect that format to be defined when execution
is implemented.

Other operations do not go through the timelock. In particular,
`emergency_withdraw` bypasses it only when the vault is already paused. See
[`emergency-procedures.md`](emergency-procedures.md).

---

## Steps

Every step requires the caller to be the contract admin and to authorize the
call (`require_auth`). Non-admin callers get `NotAdmin` (4).

### 1. Propose

```
propose_action(caller, action_type, data) -> action_id: u32
```

- Increments the action counter, so IDs start at `1` and never repeat.
- Records `proposed_at = now` and `executable_at = now + delay`.
- Stores the action with `executed = false` and `cancelled = false`.
- Emits an action-proposed event carrying the ID, the action type, and `executable_at`.

| Error | Code | When |
| --- | --- | --- |
| `NotAdmin` | 4 | Caller is not the admin. |

### 2. Wait

Wait until the ledger timestamp is at least `executable_at`. You can read the
record with:

```
get_timelock_action(action_id) -> Option<TimelockAction>
```

`TimelockAction` has `action_type`, `data`, `proposed_at`, `executable_at`,
`executed`, and `cancelled`. This is a read-only call and never fails. It
returns `None` for an ID that was never proposed.

Executing before `executable_at` fails with `TimelockDelayNotPassed` (35).

### 3. Execute

```
execute_action(caller, action_id)
```

Checks run in this order. The first failing check decides the error:

| Order | Check | Error | Code |
| --- | --- | --- | --- |
| 1 | Action exists | `TimelockActionNotFound` | 34 |
| 2 | `executed` is false | `TimelockActionAlreadyExecuted` | 36 |
| 3 | `cancelled` is false | `TimelockActionCancelled` | 37 |
| 4 | Ledger timestamp is at least `executable_at` | `TimelockDelayNotPassed` | 35 |
| 5 | Action type has an implemented arm | `NotSupported` | 25 |

Every action type currently fails at check 5. Until that changes, a successful
execution is not possible. Checks 1 to 4 still work as described, so they can
be tested and relied on.

Also, `NotAdmin` (4) applies to any non-admin caller, and it is checked before
the list above.

### 4. Cancel

```
cancel_action(caller, action_id)
```

Cancel is allowed at any time before the action is executed, including before
`executable_at`. It sets `cancelled = true` and emits an action-cancelled event.
Cancelling is permanent: the contract has no way to un-cancel an action, so a
cancelled action cannot be executed.

Checks run in this order:

| Order | Check | Error | Code |
| --- | --- | --- | --- |
| 1 | Action exists | `TimelockActionNotFound` | 34 |
| 2 | `executed` is false | `TimelockActionAlreadyExecuted` | 36 |
| 3 | `cancelled` is false | `TimelockActionCancelled` | 37 |

Cancelling a second time returns `TimelockActionCancelled` (37).

---

## Error reference

Each code below is defined in
[`errors.rs`](../soroban-contracts/contracts/single_rwa_vault/src/errors.rs).

| Code | Variant | Returned by | Meaning |
| --- | --- | --- | --- |
| 4 | `NotAdmin` | `propose_action`, `execute_action`, `cancel_action` | Caller is not the admin. |
| 25 | `NotSupported` | `execute_action` | The action type has no execution path yet. |
| 34 | `TimelockActionNotFound` | `execute_action`, `cancel_action` | No action with this ID. |
| 35 | `TimelockDelayNotPassed` | `execute_action` | Ledger timestamp is before `executable_at`. |
| 36 | `TimelockActionAlreadyExecuted` | `execute_action`, `cancel_action` | Action is marked executed. |
| 37 | `TimelockActionCancelled` | `execute_action`, `cancel_action` | Action was cancelled. |
| 38 | `TimelockAdminOnly` | `transfer_admin` (direct call) | Admin transfer must go through `propose_action`. |

The same codes are listed in
[`contract-error-codes.md`](contract-error-codes.md).

---

## Operator checklist

- [ ] Confirm the deployed `timelock_delay` value. It cannot be changed later.
- [ ] Confirm the action type you need is one of the four listed above.
- [ ] Record the `action_id` returned by `propose_action`. Nothing else in the contract lists pending actions.
- [ ] Re-read the action with `get_timelock_action` before the delay ends.
- [ ] Do not plan execution on the timelock until execution is implemented and this guide is updated.
- [ ] To abandon an action, call `cancel_action` before anyone relies on it.
