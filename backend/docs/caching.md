# Caching Guide

The backend uses three distinct caching layers to reduce database and Stellar RPC load and to keep public vault reads available during database outages:

1. **Redis cache** (`backend/src/cache/redis.ts`) for short-lived query, simulation, analytics, and operational state.
2. **In-memory static response cache** (`backend/src/api/middleware/responseCache.ts`) for static responses populated at startup.
3. **In-memory stale-response fallback** (`backend/src/api/middleware/staleResponse.ts`) for serving recent public vault responses when PostgreSQL is unreachable.

## 1. What Is Cached, Key Formats, and TTLs

### Redis Cache (`backend/src/cache/redis.ts`)

| Data / Purpose | Cache Key Format | TTL | Source |
| --- | --- | --- | --- |
| Vault list pages | `vaults:list:{JSON.stringify(opts)}` | By `state`: `Active` = `10`s, `Funding` = `30`s, `Cancelled` = `600`s, `Matured` = `600`s, default = `30`s | `backend/src/services/vault.ts` |
| Vault detail | `vault:{contractId}` | By `vault.state`: `Active` = `10`s, `Funding` = `30`s, `Cancelled` = `600`s, `Matured` = `600`s, default = `30`s | `backend/src/services/vault.ts` |
| Vault epochs | `epochs:{contractId}:{minYield}:{maxYield}` | `30`s (`EPOCHS_CACHE_TTL`) | `backend/src/services/yield.ts` |
| Pending user yield | `pending-yield:{contractId}:{userAddress}` | `10`s (`PENDING_YIELD_CACHE_TTL`) | `backend/src/services/yield.ts` |
| Analytics summary | `analytics:summary` | `60`s (`ANALYTICS_CACHE_TTL`) | `backend/src/api/controllers/analytics.ts` |
| Platform APY benchmark | `analytics:apy:benchmark` | `300`s (`BENCHMARK_CACHE_TTL`) | `backend/src/api/controllers/analytics.ts` |
| Simulation results | `sim:{contractId}:{operation}:{sha256(params).slice(0, 16)}` | `5`s (`SIMULATION_CACHE_TTL_SECONDS`) | `backend/src/api/controllers/simulate.ts` |
| Revoked / unknown API key negative cache | `revoked_key:{sha256(plaintext)}` | `300`s / 5 min (`REVOKED_KEY_CACHE_TTL_SECONDS`) | `backend/src/api/middleware/auth.ts` |
| Failed auth IP lockout counter | `auth_fail:{ip}` | `900`s / 15 min (`AUTH_FAIL_LOCKOUT_TTL_SECONDS`) | `backend/src/api/middleware/auth.ts` |
| Webhook hourly throttle counter | `webhook:throttle:{webhookId}:{YYYY-MM-DDTHH}` | `7200`s / 2 hours (`THROTTLE_TTL_SECONDS`) | `backend/src/services/webhookThrottle.ts` |
| SSE last event ID per vault | `sse:vault:{contractId}:lastEventId` | `2592000`s / 30 days (`LAST_EVENT_ID_TTL_SECONDS`) | `backend/src/services/sseManager.ts` |
| API key 24h usage sorted set | `api_key_usage:{apiKeyId}` | `172800`s / 48 hours (`API_KEY_USAGE_WINDOW_SECONDS * 2`) | `backend/src/cache/redis.ts` |

### In-Memory Static Response Cache (`backend/src/api/middleware/responseCache.ts`)

- Stores serialized static responses in a process-local `Map<string, CachedResponse>` with no TTL expiration.
- Populated at startup by `initStaticCache()` in `backend/src/app.ts` (key: `"openapi.json"`), and served via `staticCacheMiddleware(cacheKey)`.

### In-Memory Stale-Response Store (`backend/src/api/middleware/staleResponse.ts`)

- Stores up to `500` (`MAX_ENTRIES`) serialized JSON responses in a process-local `Map<string, StaleEntry>`, keyed by `req.originalUrl` (LRU eviction drops the oldest entry once the cap is reached).
- Mounted via `captureForStaleFallback` on:
  - `GET /api/v1/vaults`
  - `GET /api/v1/vaults/:contractId`
- Retention TTL is `FRESH_MAX_AGE_SECONDS` (`10`s) + `STALE_TTL_SECONDS` (default `600`s). Setting `STALE_TTL_SECONDS=0` disables capture.
- Only **anonymous** `200` `GET` responses are captured; authenticated requests (`req.apiKey`) are never stored because key-level vault scopes can change what a caller sees.

## 2. Invalidation

- **Vault mutations & indexing:**
  - `VaultService.upsertVault` (`backend/src/services/vault.ts`) deletes `vault:{contractId}`, `vaults:list:*`, and `sim:{contractId}:*`.
  - Admin vault updates and deletes (`backend/src/api/controllers/admin.ts`) delete `vault:{contractId}*` and `vaults:list:*`.
  - The indexer (`backend/src/services/indexer.ts`) deletes `vault:{contractId}` on vault state/asset updates and `pending-yield:{contractId}:{userAddress}` on yield claims.
- **Epochs:** Recording a new epoch in `YieldService` (`backend/src/services/yield.ts`) deletes `epochs:*`.
- **Analytics, simulations, revoked keys, counters:** Expire automatically via their Redis TTLs.
- **Static response cache:** Cleared explicitly by calling `invalidateCache()` in `backend/src/api/middleware/responseCache.ts`.
- **Stale-response store:** Entries expire after `10 + STALE_TTL_SECONDS` seconds or are evicted once more than `500` unique URLs are stored.

## 3. Behaviour When Redis Is Down (or `REDIS_URL` Is Unset)

Redis is optional and configured via `REDIS_URL` (`lazyConnect: true`, `maxRetriesPerRequest: 1`). Every helper in `backend/src/cache/redis.ts` catches connection and command errors so a Redis outage never breaks request handling:

- `cacheGet(key)` returns `null` — callers fall through directly to PostgreSQL or Stellar RPC.
- `cacheSet(key, value, ttl)` and `cacheDel(pattern)` are best-effort no-ops.
- `recordApiKeyUsage(...)` silently no-ops; `getApiKeyUsage(...)` returns an empty summary (`requestCount24h: 0, lastUsedAt: null, topRoutes: []`).
- `incrementCounter(key, ttl)` returns `null`:
  - `isWebhookThrottled` (`backend/src/services/webhookThrottle.ts`) fails open and allows webhook delivery so events are not silently dropped.
  - Failed-authentication lockout in `auth.ts` skips Redis-backed lockout counting.
- `SseManager.warmVaultCounter` (`backend/src/services/sseManager.ts`) skips warming and uses the in-memory counter starting from `0`.

## 4. When Stale Data Is Served (Database Outage Fallback)

When a request fails with a database-unavailability error (`isDatabaseUnavailableError(err)` in `backend/src/api/middleware/errors.ts`), `errorHandler` calls `sendStaleResponse(req, res)`:

1. **Eligible requests:** Anonymous `GET` requests (`!req.apiKey`) to `GET /api/v1/vaults` or `GET /api/v1/vaults/:contractId` that have a non-expired entry in `staleResponses`.
2. **Stale response:** Returns `200 OK` with the stored JSON body and headers:
   - `Content-Type: application/json; charset=utf-8`
   - `X-Cache: STALE`
   - `Warning: 110 - "Response is Stale"`
   - `Cache-Control: no-store`
3. **Fallback when ineligible or missing:** If the request is authenticated, uses another method/route, or has no cached copy (or `STALE_TTL_SECONDS=0`), `sendStaleResponse` returns `false` and the error handler responds with `503 Service Unavailable` (`SERVICE_UNAVAILABLE`) and `Retry-After: 30`.
