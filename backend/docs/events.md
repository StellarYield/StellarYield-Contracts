# Indexer Event Reference

Reference for every on-chain event parser in [`services/indexer.ts`](../src/services/indexer.ts).
`Indexer.processEvent()` tries each parser in order against the raw Soroban event; the first
match wins, the event is persisted to `indexed_events`, and any associated DB writes / webhook
notifications fire. Topic values are the `symbol` in `topics[0]` the parser matches on.

| Topic | Parser Function | DB Effect | Webhook Fired |
|---|---|---|---|
| `deposit` | `parseDepositEvent` | Upserts `user_vault_positions` (shares/deposited +=), updates `vaults.total_assets`/`total_shares_ever_minted`, inserts `vault_tvl_snapshots` | `user.deposit`; `vault.funded` once when the deposit crosses `funding_target` |
| `withdraw` | `parseWithdrawEvent` | Decrements `user_vault_positions` (floored at 0), updates `vaults.total_shares_ever_burned`, inserts `vault_tvl_snapshots` | `user.withdraw` |
| `yield_dis` | `parseYieldDistributedEvent` | Inserts `epochs` row, `vault_tvl_snapshots`, and one `share_balance_snapshots` row per active shareholder | `yield_distributed` |
| `st_chg` / `vault_state_changed` | `parseVaultStateChangedEvent` | Updates `vaults.state` | `vault_state_changed`; also `vault.matured` when `newState === "Matured"` |
| `fund_cxl` / `funding_cancelled` / `cancel_funding` | `parseCancelFundingEvent` | `VaultService.upsertVault` sets `vaults.state = 'Cancelled'` | `cancel_funding`; `vault.cancelled` |
| `v_create` / `vault_created` | `parseVaultCreatedEvent` | `VaultService.upsertVault` inserts the new `vaults` row (state `Funding`), fetches RWA metadata via RPC | `vault_created` |
| `v_rem` / `vault_removed` | `parseVaultRemovedEvent` | Sets `vaults.archived = TRUE` (soft delete) | none |
| `op_add` | `parseOperatorAddedEvent` (alias: `parseOpAddEvent`) | Upserts `vault_operators`, clearing `removed_at`/`removed_by` | none |
| `op_rem` | `parseOperatorRemovedEvent` (alias: `parseOpRemEvent`) | Upserts `vault_operators` with `removed_at = NOW()` | none |
| `role_grt` | `parseRoleGrantedEvent` | Upserts `vault_roles`, clearing `revoked_at` | none |
| `role_rvk` | `parseRoleRevokedEvent` | Updates `vault_roles.revoked_at = NOW()` for the active grant | none |
| `erq_req` / `request_early_redemption` | `parseRequestEarlyRedemptionEvent` | Inserts/updates `redemption_requests` | `user.early_redemption_requested` |
| `yield_clm` | `parseYieldClaimedEvent` | Bumps `user_vault_positions.last_claimed_epoch`, invalidates `pending-yield:*` cache | none |
| `prt_yld` | `parseYieldClaimedPartialEvent` | Same as `yield_clm` (shares the `handleYieldClaimed` handler) | none |
| `erq_done` / `early_redemption_processed` | `parseEarlyRedemptionProcessedEvent` | Sets `redemption_requests.processed = TRUE` | none |
| `erq_can` / `erq_can2` / `early_redemption_cancelled` | `parseEarlyRedemptionCancelledEvent` | Sets `redemption_requests.processed = TRUE` | none |
| `zkme_upd` | `parseZkmeVerifierUpdatedEvent` | Updates `vaults.zkme_verifier_address` | none |
| `kyc_set` | `parseKycSetEvent` | `UserService.upsertUser`, inserts an `indexed_events` row directly (bypasses `recordEvent`) | none |
| `paused` / `v_pause` | `parsePausedEvent` | Sets `vaults.paused = TRUE` | none |
| `unpaused` / `v_unpause` | `parseUnpausedEvent` | Sets `vaults.paused = FALSE` | none |
| `kyc_set` | `parseKycVerifiedEvent` | `UserService.upsertUser` (dead branch in practice — `parseKycSetEvent` matches `kyc_set` first and returns) | none |

## Parsers not wired into `processEvent`

These are exported for unit testing / historical compatibility but are not called from
`Indexer.processEvent()` directly:

- `parseEarlyRedemptionRequestedEvent` (topic `erq_req`) — superseded by `parseRequestEarlyRedemptionEvent`.
- `parseOpAddEvent` / `parseOpRemEvent` — thin aliases around `parseOperatorAddedEvent` / `parseOperatorRemovedEvent`.

## Adding a new event parser

1. Add a `parse<EventName>Event(rawEvent: unknown): Parsed<EventName>Event | null` function that
   matches on `topics[0]` and returns `null` for any other event (parsers are tried in sequence
   and must not throw).
2. Add a `handle<EventName>` method on `Indexer` for the DB write, and call it — plus
   `this.recordEvent(event, "<event_type>")` — from a new branch in `processEvent()`.
3. If subscribers should be notified, call `this.notificationService?.notify("<webhook.name>", ...)`
   and add the event to [`webhooks.md`](./webhooks.md).
4. Add a row to the table above.
