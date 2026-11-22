# StellarYield GraphQL API

The StellarYield backend exposes a GraphQL API via Apollo Server alongside its REST endpoints.

## Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/graphql` | `POST` | Execute GraphQL queries |
| `/api/graphql/schema` | `GET` | Download the full GraphQL SDL (`Content-Type: application/graphql`) |

- **Introspection** is enabled when `NODE_ENV !== "production"` and disabled in production.
- **Apollo Landing Page (Sandbox)** is enabled only when `NODE_ENV === "development"` and disabled otherwise.

## Authentication

Pass an API key using the `Authorization` header with a `Bearer` token:

```http
Authorization: Bearer <your-api-key>
```

On each request, the server hashes the bearer token with SHA-256 and looks up the matching record in `api_keys` to resolve `context.role`.

- **Public queries** (`health`, `user`, `epochs`, `vaultsByStatus`) do not require an API key.
- **Admin queries** (`apiKeys`) require a key with `role: "admin"`. Missing or non-admin credentials fail with a `Forbidden` GraphQL error (`extensions.code: "FORBIDDEN"`).

## Available Queries

All queries are defined in `backend/src/graphql/schema.ts`:

| Query | Arguments | Return Type | Auth | Description |
| --- | --- | --- | --- | --- |
| `health` | — | `String` | Public | Returns `"ok"` when the GraphQL server is healthy. |
| `user` | `address: String!` | `User` | Public | Fetch a user by Stellar address (`address`, `kycVerified`, `createdAt`), or `null` if not found. |
| `epochs` | `contractId: String!` | `[Epoch!]!` | Public | List yield distribution epochs for a vault (`epoch`, `yieldAmount`, `totalShares`, `yieldPerShare`, `distributedAt`). |
| `vaultsByStatus` | `status: String!` | `[Vault!]!` | Public | List vaults matching a lifecycle state (`Funding`, `Active`, `Matured`, `Closed`, `Cancelled`, case-insensitive). Returns `contractId`, `asset`, `name`, `symbol`, `state`, `totalAssets`, `totalSupply`. |
| `apiKeys` | — | `[ApiKey!]!` | Admin | List API key metadata (`id`, `label`, `role`, `createdAt`). Requires an `admin` role API key. |

## Query Depth and Complexity Limits

To protect the database from deeply nested or overly broad queries, `backend/src/graphql/queryLimits.ts` enforces two validation rules on every GraphQL operation:

| Limit | Constant | Value | Error Message |
| --- | --- | --- | --- |
| Maximum Depth | `MAX_QUERY_DEPTH` | `7` | `Query depth <depth> exceeds maximum of 7` |
| Maximum Complexity | `MAX_QUERY_COMPLEXITY` | `200` | `Query complexity <actual> exceeds maximum of 200` |

### How Complexity Is Calculated

- Every scalar or object field costs **`1`**, plus the complexity of its child selections.
- Every field whose type resolves to a list (unwrapping non-null wrappers) costs **`10`**, plus the complexity of its child selections.

## Example Query and Response

Query active vaults using `vaultsByStatus`:

```sh
curl -X POST http://localhost:3000/api/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query ActiveVaults($status: String!) { vaultsByStatus(status: $status) { contractId asset name symbol state totalAssets totalSupply } }",
    "variables": { "status": "Active" }
  }'
```

Example response:

```json
{
  "data": {
    "vaultsByStatus": [
      {
        "contractId": "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
        "asset": "USDC",
        "name": "Stellar Treasury Vault",
        "symbol": "syUSDC",
        "state": "Active",
        "totalAssets": "2500000000000",
        "totalSupply": "2450000000000"
      }
    ]
  }
}
```
