# Rate Limits Reference

Rate limiting is enforced with `express-rate-limit` in `backend/src/api/middleware/rateLimit.ts`, using a fixed `60`-second (`WINDOW_MS = 60 * 1000`) window per tier.

## 1. Rate-Limit Tiers

| Tier | Middleware | Env Var | Default Limit | Applied Routes (`backend/src/app.ts`, `backend/src/api/routes/vaults.ts`) |
| --- | --- | --- | --- | --- |
| **Public** | `publicLimiter` | `RATE_LIMIT_PUBLIC` | `60` req / min | `/api/v1/health`, `/api/v1/announcements`, `/api/v1/platform`, `/api/v1/vaults`, `/api/v1/users`, `/api/v1/yields`, `/api/v1/analytics`, `/api/v1/factory`, `/api/v1/validate`, `/api/v1/utils`, `/api/v1/codegen` |
| **Authenticated / Admin** | `authLimiter` | `RATE_LIMIT_AUTH` | `300` req / min | `/api/v1/proxy`, `/api/v1/admin/notifications`, `/api/v1/gdpr`, `/api/v1/admin/feature-flags`, `/api/v1/admin`, `/api/v1/webhooks` |
| **Simulation** | `simulateLimiter` | `RATE_LIMIT_SIMULATE` | `30` req / min | `POST /api/v1/vaults/simulate/translate-error`, `GET /api/v1/vaults/:contractId/simulate/funding`, `POST /api/v1/vaults/:contractId/simulate` |

## 2. Response Headers

All limiters in `backend/src/api/middleware/rateLimit.ts` are configured with:
- `standardHeaders: "draft-7"` — returns the IETF `RateLimit` and `RateLimit-Policy` headers on responses.
- `legacyHeaders: false` — disables legacy `X-RateLimit-*` headers.

On `429 Too Many Requests`, `rateLimitedHandler` calls `setRetryAfter` (`backend/src/api/middleware/retryAfter.ts`):
- **`Retry-After`:** Whole integer number of seconds (`Math.max(1, Math.ceil(seconds))`) counting down to `req.rateLimit.resetTime` (falling back to `60` seconds if `resetTime` is unavailable).

Other `429` / `503` endpoints that use `setRetryAfter`:
- **Failed auth IP lockout** (`backend/src/api/middleware/auth.ts`): after `20` failed authentication attempts, returns `429` with `Retry-After: 900` (15 minutes).
- **SSE per-IP connection limit** (`backend/src/api/middleware/sseLimitPerIp.ts`): returns `429` with `Retry-After: 60` (`SSE_RETRY_AFTER_SECONDS`).
- **Database unavailable** (`backend/src/api/middleware/errors.ts`): returns `503` with `Retry-After: 30` (`UNAVAILABLE_RETRY_AFTER_SECONDS`).

## 3. `429` Response Shape

When any `rateLimit.ts` tier is exceeded, `rateLimitedHandler` responds with HTTP `429` and:

```json
{
  "error": "TooManyRequests",
  "message": "Rate limit exceeded"
}
```

## 4. Per-Key Overrides

Individual API keys can carry a custom per-minute limit in `api_keys.rate_limit_override` (`INTEGER`, nullable; added in `backend/src/db/migrations/040_api_key_rate_limit_override.sql`):

- **Database column:** `api_keys.rate_limit_override` is loaded onto `req.apiKey.rateLimitOverride` during authentication (`backend/src/api/middleware/auth.ts`) and preserved when rotating keys (`backend/src/scripts/rotate-api-key.ts`).
- **Middleware helper:** `perKeyLimiter(overrideLimit)` (`backend/src/api/middleware/rateLimit.ts`) creates a `60`-second window limiter with `max: overrideLimit`, `standardHeaders: "draft-7"`, `legacyHeaders: false`, and `keyGenerator: (req) => req.apiKey?.label ?? req.ip ?? "unknown"`.
