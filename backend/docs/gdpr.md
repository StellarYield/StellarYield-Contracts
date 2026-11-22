# GDPR Data Export and Deletion Guide

Operator reference for handling GDPR data-subject access/portability requests (Art. 15 / Art. 20) and erasure requests (Art. 17).

Implemented in [`backend/src/api/controllers/gdpr.ts`](../src/api/controllers/gdpr.ts) and mounted at `/api/v1/gdpr` in [`backend/src/api/routes/gdpr.ts`](../src/api/routes/gdpr.ts).

---

## Authentication & Prerequisites

Both endpoints require:
- An **admin** API key (`requireApiKey({ role: "admin" })`).
- Source IP allowed by `ipAllowlist()`.
- Subject to `authLimiter` rate limiting.
- A valid Stellar address for `:address` (validated by `stellarAddressSchema`; invalid addresses return `400 VALIDATION_ERROR`).
- An existing row in `users` for that address (otherwise returns `404 NotFound`).

Every call records an entry in the admin audit log (`gdpr_export`, `gdpr_erasure_dry_run`, or `gdpr_erasure`).

---

## 1. Data Export (Art. 15 / Art. 20)

### Triggering a Request

```bash
curl -sS \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  "https://<host>/api/v1/gdpr/users/<STELLAR_ADDRESS>/export"
```

*(Note: `GET /api/v1/users/:address/data-export` is a separate support ZIP archive; `/api/v1/gdpr/users/:address/export` returns the machine-readable JSON document.)*

### Export Format

The response is a JSON document with:
- `format`: `"gdpr-data-export"`
- `version`: `1`
- `exportedAt`: ISO 8601 timestamp
- `subject`: `{ address, kycVerified, amlFlagged, amlFlaggedAt, createdAt, updatedAt }`
- `recordCounts`: per-category integer counts matching the arrays in `data`
- `data`: object containing 9 arrays (`positions`, `shareBalanceSnapshots`, `redemptionRequests`, `notificationPreferences`, `vaultRoles`, `feeRebates`, `blacklistedAddresses`, `events`, `archivedEvents`). `NUMERIC` columns are serialized as decimal strings and timestamps as ISO 8601.

---

## 2. Table Inventory (Export & Erasure)

| Table | Export (`GET .../export`) | Erasure (`DELETE ...`) | Match Condition |
| --- | --- | --- | --- |
| `users` | Included (`subject`) | **Deleted** (`profile`) | `address = $1` |
| `user_notification_preferences` | Included (`notificationPreferences`) | **Deleted** | `user_address = $1` |
| `vault_blacklisted_addresses` | Included (`blacklistedAddresses`) | **Deleted** | `address = $1` |
| `user_vault_positions` | Included (`positions`) | **Anonymized** (`user_address = "[REDACTED]"`) | `user_address = $1` |
| `share_balance_snapshots` | Included (`shareBalanceSnapshots`) | **Anonymized** (`user_address = "[REDACTED]"`) | `user_address = $1` |
| `redemption_requests` | Included (`redemptionRequests`) | **Anonymized** (`user_address = "[REDACTED]"`) | `user_address = $1` |
| `vault_roles` | Included (`vaultRoles`) | **Anonymized** (`user_address = "[REDACTED]"`) | `user_address = $1` |
| `fee_rebates` | Included (`feeRebates`) | **Anonymized** (`address = "[REDACTED]"`) | `address = $1` |
| `indexed_events` | Included (`events`) | **Redacted in place** (`payload.user` & `payload.address` -> `"[REDACTED]"`) | `payload->>'user' = $1 OR payload->>'address' = $1` |
| `indexed_events_archive` | Included (`archivedEvents`) | **Redacted in place** (`payload.user` & `payload.address` -> `"[REDACTED]"`) | `payload->>'user' = $1 OR payload->>'address' = $1` |

`vaults` is also joined (read-only) during export to include `contract_id` on `positions`, `shareBalanceSnapshots`, `redemptionRequests`, `vaultRoles`, and `blacklistedAddresses`.

> **Note on event matching:** Only events whose `payload` carries a flat `user` or `address` JSON key are matched by the export and redaction queries. Deposit/withdraw events that store raw on-chain payloads without those flat keys are not matched by subject address.

---

## 3. Data Erasure (Art. 17)

### Step 1: Dry Run (Recommended)

Preview the exact row counts that will be deleted (`erased`) vs. anonymized/redacted (`anonymized`) without modifying the database:

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  "https://<host>/api/v1/gdpr/users/<STELLAR_ADDRESS>?dryRun=true"
```

Returns `{ address, mode: "dry-run", erased, anonymized }`.

### Step 2: Apply Erasure

Execute the erasure inside a single database transaction:

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  "https://<host>/api/v1/gdpr/users/<STELLAR_ADDRESS>?confirm=true"
```

- Calling `DELETE` without `?dryRun=true` or `?confirm=true` (or with `?confirm=false`) is rejected with `400 BadRequest`.
- Returns `{ address, mode: "applied", erasedAt, erased, anonymized, retentionNote }`.

---

## 4. What Is Not Deleted and Why

1. **Financial & Accounting Records (`user_vault_positions`, `share_balance_snapshots`, `redemption_requests`, `vault_roles`, `fee_rebates`):**
   Anonymized in place (`"[REDACTED]"`) rather than deleted to satisfy financial-services record-keeping and audit obligations.
2. **Indexed On-Chain Events (`indexed_events`, `indexed_events_archive`):**
   Redacted in place (`payload.user` and `payload.address` set to `"[REDACTED]"`) rather than deleted, preserving immutable event-log structure while removing the subject's identifier.
3. **Subjects Under an Active AML Hold (`users.aml_flagged = true`):**
   Erasure (including dry-run) is refused with `409 Conflict`. Under GDPR Art. 17(3)(b)/(e), the regulatory obligation to retain AML-flagged records overrides the erasure request until compliance clears the hold via `POST /api/v1/admin/users/:address/aml-clear`.
4. **Unique-Constraint Collisions on `[REDACTED]`:**
   `user_vault_positions`, `share_balance_snapshots`, and `vault_roles` have `UNIQUE` constraints keyed on the address. If a subject's rows would collide with an existing `"[REDACTED]"` row, the transaction rolls back (`500`) rather than merging two subjects' financial records.
