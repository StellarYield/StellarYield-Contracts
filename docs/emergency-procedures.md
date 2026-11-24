# Emergency Procedures Runbook

This runbook is for the operators of a `single_rwa_vault` deployment. It covers
how emergency mode is entered, how emergency signers approve a withdrawal, how
holders claim afterwards, and which steps can and cannot be reversed.

Source of truth:
- Entry points: [`lib.rs`](../soroban-contracts/contracts/single_rwa_vault/src/lib.rs) (`pause`, `unpause`, `emergency_withdraw`, `set_emergency_signers`, `propose_emergency_withdraw`, `approve_emergency_withdraw`, `execute_emergency_withdraw`, `emergency_enable_pro_rata`, `emergency_claim`, `pending_emergency_claim`)
- Error codes: [`errors.rs`](../soroban-contracts/contracts/single_rwa_vault/src/errors.rs)
- Roles: [`rbac-roles.md`](rbac-roles.md)
- Timelock (separate mechanism, not used here): [`timelock.md`](timelock.md)

---

## Read this first: what is irreversible

| Step | Reversible? | Why |
| --- | --- | --- |
| `pause` | **Yes** | `unpause` (admin) clears the pause flag and all freeze flags. |
| `emergency_enable_pro_rata` | **No** | No function moves the vault out of the `Emergency` state. `unpause` clears the pause flag but leaves the state as it is. |
| `emergency_claim` | **No** | Claimed shares are burned and the transfer is final. A holder can claim only once. |
| `emergency_withdraw` (single key) | **No** | The vault's full asset balance is transferred to the recipient. No function returns it. |
| `execute_emergency_withdraw` (multisig) | **No** | Same transfer as above. A proposal cannot be executed twice, and there is no way to undo an execution. |
| `set_emergency_signers` | Yes, for the configuration | You can replace or clear the signer set. Pending proposals and their approvals are not removed. See [Known gaps](#known-gaps). |

Before any step marked **No**, get explicit sign-off from the people who hold
the admin and signer keys.

---

## Roles and signer requirements

| Action | Who may call it | Error if not allowed |
| --- | --- | --- |
| `pause` | `TreasuryManager` role, `FullOperator`, or admin | `NotOperator` (3) |
| `unpause` | Admin only | `NotAdmin` (4) |
| `set_emergency_signers` | Admin only | `NotAdmin` (4) |
| `emergency_withdraw` | `TreasuryManager` role, `FullOperator`, or admin. Only when **no** signers are configured. | `NotSupported` (25) if signers are configured. `NotOperator` (3) if the role is missing. |
| `emergency_enable_pro_rata` | Admin only | `NotAdmin` (4) |
| `propose_emergency_withdraw`, `approve_emergency_withdraw`, `execute_emergency_withdraw` | Configured emergency signers only | `NotEmergencySigner` (39) |
| `emergency_claim` | Any holder with shares, once per holder | See [Claims](#holders-claim-afterwards) |

### Configuring signers

```
set_emergency_signers(caller, signers: Vec<Address>, threshold: u32)
```

- Admin only.
- `signers` empty: clears the multisig configuration. Single-key `emergency_withdraw` is available again.
- `signers` non-empty: `threshold` must satisfy `1 <= threshold <= signers.len()`. Otherwise the call returns `InvalidThreshold` (45) and nothing changes.
- While signers are configured, the single-key `emergency_withdraw` is disabled and returns `NotSupported` (25).

The contract does not check the signer list for duplicate addresses. See
[Known gaps](#known-gaps).

---

## Path A: pro-rata distribution (`Emergency` state)

Use this when the vault should stop and return its remaining assets to holders
in proportion to their shares.

1. **Enable pro-rata mode**: `emergency_enable_pro_rata(admin)`.
   - Requires the admin and a total supply above zero. If supply is zero, the call returns `ZeroAmount` (13).
   - Sets the vault state to `Emergency`, snapshots the vault's asset balance and the total share supply, and sets the pause flag.
   - Emits a state-changed event and an emergency-mode event.
2. **Confirm the snapshot** with `vault_state()` (should be `Emergency`) and by reading the pending claim for a known holder with `pending_emergency_claim(user)`.
3. **Tell holders to claim** (see [Claims](#holders-claim-afterwards)).

> **Do not call `emergency_enable_pro_rata` a second time.** The contract does not check whether the vault is already in `Emergency`. A second call overwrites the balance and supply snapshot with current values, after some holders may already have claimed. That changes the payout for every holder who has not claimed yet.

---

## Path B: withdrawal to one recipient

There are two routes. Use the multisig route when signers are configured. The
single-key route works only when they are not.

### B1. Single key (no signers configured)

1. Pause the vault: `pause(caller, reason)`. This is **required**. `emergency_withdraw` returns `TimelockAdminOnly` (38) if the vault is not already paused.
2. Call `emergency_withdraw(caller, recipient)`.
   - Checks the caller holds the `TreasuryManager` role (or `FullOperator` or admin).
   - Sets the pause flag and all freeze flags, then transfers the vault's **entire** asset balance to `recipient`.
   - If the balance is zero, no transfer is made, and the call still pauses the vault.

### B2. Multisig (signers configured)

Each step needs a configured signer. The proposer approves automatically.

1. **Propose**: `propose_emergency_withdraw(signer, recipient)` returns a `proposal_id`.
2. **Approve**: each other signer calls `approve_emergency_withdraw(signer, proposal_id)`.
   - Each signer may approve once. A second approval returns `AlreadyApproved` (44).
   - Approvals are accepted only while the proposal is within its timeout (see below).
3. **Execute**: once the approval count reaches the threshold, any signer calls `execute_emergency_withdraw(signer, proposal_id)`.
   - If the count is below the threshold, the call returns `ThresholdNotMet` (43).
   - Marks the proposal executed, sets the pause flag and all freeze flags, and transfers the vault's **entire** asset balance to the recipient.
   - Emits an executed event with the proposal ID, recipient, and amount.

**Timeout.** A proposal is valid for **86,400 seconds (24 hours)** from `proposed_at`. Approve and execute both return `ProposalExpired` (41) once `now > proposed_at + 86400`. A proposal that has been executed returns `ProposalAlreadyExecuted` (42). A proposal ID that does not exist returns `ProposalNotFound` (40).

**Threshold.** The approval count includes the proposer. A 2-of-3 setup means the proposer plus one other signer.

Do not expect the vault to be paused before a multisig proposal. Execution sets
the pause flag itself.

---

## Holders claim afterwards

Claims are possible only in the `Emergency` state (Path A). They do **not**
apply after a Path B withdrawal. See [Known gaps](#known-gaps).

1. Each holder calls `emergency_claim(holder)`.
   - Returns `NotInEmergency` (29) if the vault is not in `Emergency`.
   - Returns `AlreadyClaimedEmergency` (30) if this holder already claimed.
   - Returns `ZeroAmount` (13) if the holder has no shares.
2. The payout is `emergency_balance * holder_shares / total_supply_snapshot`, rounded down.
3. The holder's shares are **burned** and the payout is transferred. If the payout rounds to zero, the shares are still burned and the holder is marked as claimed, and no transfer is made.
4. `pending_emergency_claim(holder)` returns the amount a holder would receive, or `0` if the holder has already claimed, has no shares, or the vault is not in `Emergency`.

---

## Reversal

- **Pause**: call `unpause(admin)`. This clears the pause flag and sets freeze flags to `0`. Nothing else changes.
- **Emergency state**: there is no reversal. After `emergency_enable_pro_rata`, the vault stays in `Emergency`. Deposits need the vault to be in `Funding` or `Active`, so they stay unavailable. Holders' intended action is `emergency_claim`.
- **Withdrawals**: there is no reversal. Funds sent to a recipient are not returned by the contract.
- **Signers**: `set_emergency_signers` can replace or clear the configuration. This does not cancel pending proposals or their approvals.

---

## Operator checklist

- [ ] Identify the incident and choose a path: pause only, Path A, or Path B.
- [ ] Get written sign-off from the admin and from the signers before any irreversible step.
- [ ] Confirm the current signer list and threshold. The contract has no on-chain getter for them, so use your deployment records and the `set_emergency_signers` transaction history.
- [ ] Check the signer list has no duplicate addresses (see [Known gaps](#known-gaps)).
- [ ] Pause the vault first (`pause`). Path B1 requires this.
- [ ] For Path B2, record the `proposal_id` and the timeout (`proposed_at + 86400`).
- [ ] Count the approvals and confirm they reach the threshold before executing.
- [ ] Verify the recipient address twice. A withdrawal cannot be reversed.
- [ ] For Path A, call `emergency_enable_pro_rata` once only. Confirm `vault_state()` is `Emergency`.
- [ ] Publish the claim instructions to holders: one claim each, through `emergency_claim`.
- [ ] Record every transaction hash and event for the incident report.
- [ ] Decide what happens to holders after a Path B withdrawal. The contract provides no on-chain claim for them.

---

## Known gaps

These behaviours are in the code as it stands. Operators should plan around
them until the contract changes.

1. **No on-chain claim after a withdrawal.** Path B leaves the vault state
   unchanged and does not create a claim path. `emergency_claim` requires the
   `Emergency` state. Holders' shares remain outstanding with no on-chain
   redemption.
2. **Pro-rata mode can be re-entered.** `emergency_enable_pro_rata` has no state
   guard. A second call replaces the snapshot. See the warning in Path A.
3. **Duplicate signers are not rejected.** `set_emergency_signers` accepts the
   same address more than once. An address can approve only once, so a
   duplicated entry does not add a vote. For example, `[A, A, B]` with
   threshold `3` passes validation (`3 <= 3`), but only two distinct addresses
   can approve, so the threshold can never be reached.
4. **Signer changes do not cancel pending approvals.** Approvals are stored by
   address and are not rechecked against the current signer list. Replacing
   signers, or lowering the threshold, changes what a pending proposal needs
   before it executes. Review open proposals after any signer change.
5. **`emergency_enable_pro_rata` ignores multisig.** It is admin-only, even when
   signers are configured. The admin key alone can move the vault into pro-rata
   mode.
