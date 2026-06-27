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

Docker Compose reads `.env.example` and overrides `DATABASE_URL` so the backend
connects to the `postgres` service.

## API Routes

- `GET /health` - service and database health check.
- `GET /api/v1/vaults` - list vaults.
- `GET /api/v1/vaults?q=bond` - search vaults by name or symbol using full-text search.
- `GET /api/v1/vaults/count` - return the total number of vaults.
- `GET /api/v1/vaults/factory/:factoryId` - list vaults for a factory.
- `GET /api/v1/vaults/:contractId` - get a vault by contract ID.
- `GET /api/v1/vaults/:contractId/positions` - list vault positions.
- `GET /api/v1/vaults/:contractId/holders?page=&pageSize=&sort=` - list active vault holders, sorted by `shares` or `deposited`.
- `GET /api/v1/vaults/:contractId/holders/count` - return the active holder count for a vault.
- `GET /api/v1/vaults/:contractId/holders/export.csv` - export active vault holders as a protected CSV attachment.
- `GET /api/v1/vaults/:contractId/early-redemption-fee?shares=` - preview the early redemption fee breakdown for a share amount.
- `GET /api/v1/vaults/:contractId/export.csv` - export vault data as a CSV attachment.
- `GET /api/v1/users/:address` - get a user by Stellar address.
- `GET /api/v1/users/:address/kyc?vaultId=:contractId` - live-read on-chain KYC status for a vault.
- `GET /api/v1/users/:address/portfolio` - get a user's portfolio.
- `GET /api/v1/users/:address/share-history?vaultId=:contractId` - get epoch-ordered share balance history; omit `vaultId` to aggregate across vaults by epoch.
- `POST /api/v1/users/portfolios/batch` - batch-fetch portfolios for up to 50 addresses (`{ addresses: string[] }`).
- `GET /api/v1/yields/:contractId/epochs` - list vault yield epochs.
- `GET /api/v1/yields/:contractId/pending/:userAddress` - get pending yield.

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
