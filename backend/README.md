# StellarYield Backend

Express API for StellarYield. It indexes on-chain data, stores it in PostgreSQL,
and exposes REST endpoints for vault, user, and yield data.

## Prerequisites

- Node.js 20+
- npm
- Docker and Docker Compose

## Local Setup With Docker Compose

From this `backend/` directory:

```sh
docker compose up --build
```

The API is available at `http://localhost:3000`.

Check health:

```sh
curl http://localhost:3000/health
```

Run database migrations once:

```sh
docker compose --profile migrate run --rm db-migrate
```

Stop services:

```sh
docker compose down
```

Remove the local PostgreSQL volume:

```sh
docker compose down -v
```

## Local Setup Without Docker

Create a local environment file:

```sh
cp .env.example .env
```

Install dependencies, build, migrate, and start:

```sh
npm ci
npm run build
npm run db:migrate
npm start
```

For development with file watching:

```sh
npm run dev
```

## Available Scripts

- `npm run build` - compile TypeScript to `dist/`.
- `npm start` - run `node dist/index.js`.
- `npm run dev` - run the API with `tsx watch`.
- `npm run lint` - lint files under `src/`.
- `npm test` - run the Vitest suite.
- `npm run db:migrate` - apply `src/db/schema.sql` to PostgreSQL.
- `npm run db:migrate:down` - drop every table/view/type the migrations created (revert script).
- `npm run db:seed` - insert sample vault and user rows (idempotent; safe to run twice).
- `npm run indexer` - run the event indexer.
- `npm run operator-expiry-task` - run operator expiry background task.
- `npm run mock-rpc` - run the mock Soroban RPC server (see below).

## Mock Soroban RPC Server

Instead of pointing the API and indexer at testnet (slow and rate-limited), you
can run a local mock that answers the RPC methods they actually call:
`getHealth`, `getLatestLedger`, `getEvents`, and `simulateTransaction`.

```sh
npm run mock-rpc
```

The server listens on `http://localhost:8001` (override with `MOCK_RPC_PORT`)
and answers JSON-RPC with data loaded from `dev/fixtures/*.json`
(`getHealth.json`, `getLatestLedger.json`, `getEvents.json`,
`simulateTransaction.json`). Edit those files to change the mock's chain tip,
event stream, or contract read results. `getEvents` fixture events are written
with plain native values (strings/numbers/arrays); the mock encodes them into
base64 XDR `ScVal`s so the Stellar SDK decodes them exactly like real chain
data. Methods outside the supported list get a standard JSON-RPC
`"Method not found"` error (`-32601`).

Then run the API or indexer against the mock:

```sh
STELLAR_RPC_URL=http://localhost:8001 npm run dev
STELLAR_RPC_URL=http://localhost:8001 npm run indexer
```

With the fixture events targeting the vault contract configured in
`VAULT_FACTORY_CONTRACT_ID` (and `DATABASE_URL` migrated), the indexer will
process the fixture `deposit`/`withdraw`/`yield_dis`/`st_chg` events on every
poll cycle — no network access needed.

## Environment Variables

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | HTTP server port. |
| `NODE_ENV` | No | `development` | Runtime environment. |
| `DATABASE_URL` | Yes | none | PostgreSQL connection string. |
| `STELLAR_NETWORK` | No | `testnet` | Stellar network name. |
| `STELLAR_RPC_URL` | No | Soroban testnet RPC | Stellar RPC endpoint. |
| `STELLAR_NETWORK_PASSPHRASE` | No | Testnet passphrase | Network passphrase. |
| `VAULT_FACTORY_CONTRACT_ID` | **Recommended** | empty | Vault factory contract ID. **Required for event indexing.** If empty, the indexer will skip event polling and only update `indexer_state`, logging a warning at startup. |
| `ZKME_VERIFIER_CONTRACT_ID` | No | empty | zkMe verifier contract ID. |
| `INDEXER_START_LEDGER` | No | `0` | Ledger to begin indexing from. |
| `INDEXER_POLL_INTERVAL_MS` | No | `5000` | Indexer polling interval. |
| `WEBHOOK_SECRET` | No | empty | Optional webhook signing secret. |
| `ADMIN_API_KEY` | No | empty | Admin API authentication key. |
| `KEY_INACTIVITY_DAYS` | No | unset (never) | Days an API key may go unused before the daily sweep deactivates it. Never-used keys are measured from `created_at`. Deactivated keys are rejected with 401, the same response as an unknown or expired key. |
| `REQUEST_TIMEOUT_MS` | No | `30000` | Longest a request may run before it gets a 503 with `Retry-After: 5`. SSE streams are exempt. |
| `LOAD_SHED_LAG_MS` | No | `250` | Event loop p99 lag, in ms, above which non-essential requests get a 503 with `Retry-After: 5`. `/health`, `/metrics` and `/api/v1/admin` are never shed. |
| `DEBUG_ARCHIVE_ROUTES` | No | empty | Comma-separated route patterns to archive, such as `/api/v1/admin/*`. Archived requests are retained FIFO up to 1000 rows. |

Docker Compose reads `.env.example` and overrides `DATABASE_URL` so the backend
connects to the `postgres` service.

## API Routes

### Public Endpoints

- `GET /health` - service and database health check.
- `GET /api/changelog` - machine-readable API release history.
- `GET /api/v1/vaults` - list vaults.
- `GET /api/v1/vaults?q=bond` - search vaults by name or symbol using full-text search.
- `GET /api/v1/vaults/count` - return the total number of vaults.
- `GET /api/v1/vaults/factory/:factoryId` - list vaults for a factory.
- `GET /api/v1/vaults/:contractId` - get a vault by contract ID.
- `GET /api/v1/vaults/:contractId/operators` - list active operators (filters expired).
- `GET /api/v1/vaults/:contractId/positions` - list vault positions.
- `GET /api/v1/vaults/:contractId/holders?page=&pageSize=&sort=` - list active vault holders, sorted by `shares` or `deposited`.
- `GET /api/v1/vaults/:contractId/holders/count` - return the active holder count for a vault.
- `GET /api/v1/vaults/:contractId/holders/export.csv` - export active vault holders as a protected CSV attachment.
- `GET /api/v1/vaults/:contractId/early-redemption-fee?shares=` - preview the early redemption fee breakdown for a share amount.
- `GET /api/v1/vaults/:contractId/export.csv` - export vault data as a CSV attachment.
- `GET /api/v1/users/:address` - get a user by Stellar address.
- `GET /api/v1/users/:address/kyc?vaultId=:contractId` - live-read on-chain KYC status for a vault.
- `GET /api/v1/users/:address/portfolio` - get a user's portfolio.
- `GET /api/v1/users/:address/yield-history` - user yield history.
- `GET /api/v1/users/:address/deposits` - user deposits.
- `GET /api/v1/users/:address/share-history?vaultId=:contractId` - get epoch-ordered share balance history; omit `vaultId` to aggregate across vaults by epoch.
- `POST /api/v1/users/portfolios/batch` - batch-fetch portfolios for up to 50 addresses (`{ addresses: string[] }`).
- `GET /api/v1/yields/:contractId/epochs` - list vault yield epochs.
- `GET /api/v1/yields/:contractId/pending/:userAddress` - get pending yield.
- `POST /api/v1/validate` - dry-run a request body against the schema of the route it is
  destined for, without executing it. Takes `{ route, method, body }` and returns
  `{ valid, errors }`, where `errors` is the list of Zod issues (`null` when the body is
  valid). Returns 404 if no schema is registered for that route and method.

### Admin Endpoints

Require `X-API-Key` header with admin key.

- `POST /api/v1/admin/indexer/replay` - replay events for a ledger range.
- `GET /api/v1/admin/indexer/start-block` / `PUT /api/v1/admin/indexer/start-block` - read or persist the ledger a fresh indexing run starts from (admin key to write). The configured block is the origin used while the indexer cursor is still 0.
- `GET /api/v1/admin/regulatory/holder-concentration?vaultId=:contractId&topN=` - holder concentration report for one vault: cumulative top-1/5/10 shares, Herfindahl-Hirschman index, risk level, and the top holders.
- `GET /api/v1/gdpr/users/:address/export` - machine-readable JSON copy of every data category held for a user: profile, positions, balance snapshots, redemptions, notification preferences, roles, fee rebates, blacklist entries, and live plus archived events (portable copy, Art. 20). Admin key.
- `DELETE /api/v1/gdpr/users/:address?confirm=true` - erase a user's data (Art. 17). `?dryRun=true` previews the plan. Notification preferences and blacklist entries are deleted, financial records are anonymised in place, and event payloads are redacted. Refused with 409 while an AML hold is active. Admin key.
- `GET /api/v1/admin/vaults/:contractId/audit` - audit log.
- `GET /api/v1/admin/events` - indexed events.
- `GET /api/v1/admin/debug/archive` - last 50 archived request/response pairs.
- `GET /api/v1/admin/api-keys/:id/usage` - rolling 24-hour request count and top routes for an API key.

Routes listed in `ROUTE_SLA_MS` emit `X-SLA-Ms`; responses exceeding the configured target also emit `X-SLA-Exceeded: true`.

## Documentation

- [GraphQL API Guide](docs/graphql.md) - Endpoint, API key authentication, queries, and depth/complexity limits
- [Feature Flags Guide](docs/feature-flags.md) - Flag definitions, evaluation precedence, route gating, and examples
- [Webhook Documentation](docs/webhooks.md) - Webhook payload schemas and verification
- [Indexer Architecture](docs/indexer.md) - Polling loop, event dispatch, dedup, and backfill
- [Indexer Event Reference](docs/events.md) - Every event parser, its DB effect, and its webhook

## Vault States

The vault lifecycle consists of the following states:

| State | Description | Triggered By |
|-------|-------------|--------------|
| `Funding` | Initial state. Vault accepts deposits and aims to meet funding target before deadline. | Vault creation via factory |
| `Active` | Funding target met before deadline. Vault is operational and distributes yield. | Operator calls `activate_vault` after funding deadline passes with target met |
| `Matured` | Funding period ended. No new deposits accepted; yield distribution and redemptions continue. | Operator calls `mature_vault` |
| `Cancelled` | Funding deadline passed without meeting target. Depositors can withdraw refunds. | Operator calls `cancel_funding` (via `cancel_funding` event) |
| `Closed` | Vault fully wound down. All shares redeemed or refunded. | Operator action |

### Retrieving Cancelled Vaults

To fetch all cancelled vaults via the API:

```bash
GET /api/v1/vaults?state=Cancelled
```

Example response:
```json
{
  "data": [
    {
      "id": 1,
      "contractId": "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
      "state": "Cancelled",
      "totalAssets": "0",
      "totalSupply": "0",
      ...
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

## Full-Text Search

The API supports PostgreSQL full-text search for efficient vault discovery by name or symbol. The search uses:

- **GIN index** on a generated `tsvector` column for fast indexed queries
- **Relevance ranking** via `ts_rank()` to return most relevant results first
- **English language dictionary** for stemming and stop-word removal

### Search Query Parameter

Use the `q` parameter with `GET /api/v1/vaults` to search:

```bash
GET /api/v1/vaults?q=bond
```

This returns vaults containing "bond" in their name or symbol, ranked by relevance.

### Search Behavior

- **Empty or missing `q`**: Returns all vaults with standard sorting
- **With `q`**: Filters by search match and ranks by relevance (`ts_rank`)
- **Combines with filters**: Works alongside `state`, `page`, `pageSize`, etc.

### Examples

Search for "bond" vaults:
```bash
curl "http://localhost:3000/api/v1/vaults?q=bond"
```

Search active "treasury" vaults:
```bash
curl "http://localhost:3000/api/v1/vaults?q=treasury&state=Active"
```

Search with pagination:
```bash
curl "http://localhost:3000/api/v1/vaults?q=yield&page=1&pageSize=10"
```

### Implementation Details

- Search column: `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(symbol, ''))) STORED`
- Index: `CREATE INDEX idx_vaults_search_vector ON vaults USING GIN (search_vector)`
- Query: `WHERE search_vector @@ plainto_tsquery('english', $q)`
- Ranking: `ORDER BY ts_rank(search_vector, plainto_tsquery('english', $q)) DESC`
