# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Maintainers:** as you merge PRs, add an entry under `[Unreleased]` in the
> matching category below (skip categories with nothing to report). When
> cutting a release, rename `[Unreleased]` to the new version and date (e.g.
> `## [1.2.0] - 2026-07-26`), then add a fresh `[Unreleased]` section above it
> with all six empty headings restored.

## [Unreleased]

### Added

- Outbound HTTP client (`backend/src/services/apiClient.ts`) with retry using
  exponential backoff, a per-request timeout, and automatic `Authorization:
  Bearer` API key attachment. Defaults come from the new `API_CLIENT_BASE_URL`,
  `API_CLIENT_API_KEY`, `API_CLIENT_TIMEOUT_MS` and `API_CLIENT_MAX_RETRIES`
  env vars.
- API keys can be restricted to specific vaults with a new `allowed_contract_ids`
  column (migration 057) and the `--allowed-contract-ids` flag on
  `generate-api-key`. A scoped key gets 403 on another vault's routes, and
  `GET /api/v1/vaults` and `GET /api/v1/vaults/factory/:factoryId` list only its
  vaults. Public vault requests are unchanged unless they send a Bearer key.
- Authenticated responses carry `X-API-Key-Expires-In` (seconds) when the key
  expires within 14 days. The header is exposed to browser clients via CORS.
- Daily `api-key-expiry-reminder` job at 05:00 UTC logs a `warn` entry per active
  key expiring within 7 days (label and expiry date only, no key material).
  `GET /api/v1/admin/api-keys?expiringWithinDays=<1-365>` returns the same keys.
- A read-only API key that sends a write method is logged as a
  `READ_ONLY_KEY_DENIED` security event with the key's first 8 characters and the
  method. The full key is never stored (#1248).
- Public `GET /api/v1/vaults` and `GET /api/v1/vaults/:contractId` keep the last
  successful anonymous response for `STALE_TTL_SECONDS` (default 600, new env var).
  While the database is unreachable, that copy is served with `X-Cache: STALE`
  and `Warning: 110`. Other requests get 503 `SERVICE_UNAVAILABLE` (#1254).

### Changed

- `GET /api/v1/vaults/simulate/translate-error` now returns the error names and
  numbers defined by the `#[contracterror]` enum in
  `soroban-contracts/contracts/single_rwa_vault/src/errors.rs` instead of a
  hand-maintained approximation.
- `rotate-api-key` no longer deletes the old key. It sets the old key to expire
  after `--grace-days` (default 7), so clients can switch over. The new key keeps
  the same label, role, expiry, description and scope as the old one, rather than
  a `-rotated-<timestamp>` label. A label may hold at most two active keys, so a
  second rotation waits for the first grace period to end.
- `sendEmail` (`backend/src/services/email.ts`) rejects a malformed recipient
  with a `TypeError` before any SMTP call. It no longer rethrows transport
  failures: they are logged at `error` and the call resolves. The notification
  worker already caught these errors, so its behaviour does not change.

### Deprecated

### Removed

- The interactive "Delete old key? [y/N]" prompt in `rotate-api-key`.

### Fixed

- Raw API key authentication failed for every key because the key lookup query
  was missing a comma between `rate_limit_override` and `allowed_cidrs`. The query
  is fixed.
- Rate-limit 429s, the IP lockout 429 and the SSE connection-limit 429 send
  `Retry-After`. For window limits it counts down to the window reset. All 503s,
  including health checks, send `Retry-After: 30` (#1253).
- An unhandled promise rejection or uncaught exception is logged at `fatal` level
  with its stack. Logs are flushed and the process exits with code 1 so the
  supervisor restarts it (#1249).

### Security
