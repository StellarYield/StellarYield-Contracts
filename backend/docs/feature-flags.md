# StellarYield Feature Flags

The StellarYield backend provides an in-memory feature flag system (`backend/src/services/featureFlags.ts`), Express route-gating middleware (`backend/src/api/middleware/featureFlag.ts`), and admin management endpoints (`backend/src/api/routes/featureFlags.ts`).

## How Flags Are Defined

Each feature flag is represented by the `FeatureFlag` interface:

```ts
export interface FeatureFlag {
  name: string;
  enabled: boolean;
  enabledForRoles: string[];
  rolloutPercent: number; // integer 0..100
  updatedAt: Date;
}
```

Flags are held in an in-memory `Map<string, FeatureFlag>` in `backend/src/services/featureFlags.ts`.

- **Initial state**: On server startup, the map is empty — no flags are pre-seeded.
- **Defaults when created**: Calling `upsertFlag(name, patch)` for a new flag initializes:
  - `enabled: false`
  - `enabledForRoles: []`
  - `rolloutPercent: 0`
  - `updatedAt: new Date()`

### Admin Endpoints

The feature flag router is mounted at `/api/v1/admin/feature-flags`:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/admin/feature-flags` | List all currently defined feature flags. |
| `PATCH` | `/api/v1/admin/feature-flags/:name` | Create or update a flag. Body accepts `{ enabled?: boolean, rolloutPercent?: number, enabledForRoles?: string[] }`. Returns `404` if the flag does not exist and the body is `{}`. |

## Precedence and Evaluation Rules

There is no separate static or environment-variable override layer: the stored `FeatureFlag` entry in the in-memory `flags` map is the single source of truth, and any undefined flag defaults to disabled (`false`).

`isFlagEnabled(name, requestId)` evaluates a flag in the following order:

1. **Missing or disabled**: If the flag does not exist in the store or `flag.enabled === false`, it returns `false` (regardless of `rolloutPercent`).
2. **Full rollout**: If `flag.rolloutPercent >= 100`, it returns `true` for all requests.
3. **Zero rollout**: If `flag.rolloutPercent <= 0`, it returns `false` (even when `enabled` is `true`).
4. **Percentage rollout (`1`–`99`)**: Computes `sha256("${name}:${requestId}")`, parses the first 8 hex characters as an integer modulo `100` (`bucket`), and returns `true` when `bucket < flag.rolloutPercent`. This guarantees the same `requestId` consistently receives the same decision for a given flag.

> Note: `enabledForRoles` is stored on the `FeatureFlag` record and validated by `PATCH`, while `isFlagEnabled` currently gates solely on `enabled` and `rolloutPercent` keyed by `requestId`.

## Gating a Route

Use the `requireFlag(flagName)` middleware from `backend/src/api/middleware/featureFlag.ts`:

```ts
import { requireFlag } from "../middleware/featureFlag.js";

router.get("/new-feature", requireFlag("my-feature"), handler);
```

When a request hits a gated route:

1. `requireFlag` derives `requestId` from the first IP in `X-Forwarded-For`, falling back to `req.socket.remoteAddress`, then `"unknown"`.
2. It calls `isFlagEnabled(flagName, requestId)`.
3. If `false`, it responds with HTTP `404`:
   ```json
   { "error": "NotFound", "message": "Feature not available" }
   ```
4. If `true`, it calls `next()` and invokes `handler`.

## Adding a New Flag

1. **Choose a flag name** (for example, `vault-export-v2`).
2. **Gate the route(s)** with `requireFlag("vault-export-v2")`.
3. **Enable or roll out the flag** at runtime via `PATCH /api/v1/admin/feature-flags/vault-export-v2` (or `upsertFlag("vault-export-v2", { enabled: true, rolloutPercent: 100 })` in tests).

## Worked Example

Assume a route is gated with `requireFlag("vault-export-v2")` and the backend is running on `http://localhost:3000`:

1. **Check initial flags** (empty before any flag is created):

   ```sh
   curl http://localhost:3000/api/v1/admin/feature-flags
   ```

   Response:

   ```json
   []
   ```

2. **Enable the flag for 100% of traffic**:

   ```sh
   curl -X PATCH http://localhost:3000/api/v1/admin/feature-flags/vault-export-v2 \
     -H "Content-Type: application/json" \
     -d '{"enabled": true, "rolloutPercent": 100}'
   ```

   Response:

   ```json
   {
     "name": "vault-export-v2",
     "enabled": true,
     "enabledForRoles": [],
     "rolloutPercent": 100,
     "updatedAt": "2026-11-22T12:00:00.000Z"
   }
   ```

3. **Gradual rollout (e.g., 25% of client IPs)** or **disable immediately**:

   ```sh
   curl -X PATCH http://localhost:3000/api/v1/admin/feature-flags/vault-export-v2 \
     -H "Content-Type: application/json" \
     -d '{"rolloutPercent": 25}'
   ```

   To turn the feature off completely:

   ```sh
   curl -X PATCH http://localhost:3000/api/v1/admin/feature-flags/vault-export-v2 \
     -H "Content-Type: application/json" \
     -d '{"enabled": false}'
   ```
