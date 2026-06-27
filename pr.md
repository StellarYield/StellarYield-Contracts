# Pull Request: Add vault search, name-check, trending, and new vaults endpoints

This PR adds four new API endpoints for vault discovery and search.

Closes #640
Closes #641
Closes #642
Closes #643

## Changes

### 1. `GET /api/v1/vaults/search` (#640)
- Combined search endpoint accepting `q`, `category`, `state`, `sort`, `order`, `page`, `pageSize`.
- Filters are applied independently (AND logic) with full Zod validation.
- Text search (`q`) matches against `name`, `symbol`, and `rwa_name` (case-insensitive ILIKE).
- Category filter matches against `rwa_name`.
- Returns paginated vault list in the same shape as `GET /api/v1/vaults`.

### 2. `GET /api/v1/vaults/name-check` (#641)
- Accepts `name` query parameter, returns `{ "available": true | false }`.
- Case-insensitive check: `WHERE LOWER(name) = LOWER($1)`.
- Returns HTTP 400 if name is missing or under 3 characters.

### 3. `GET /api/v1/vaults/trending` (#642)
- Returns top 10 vaults ordered by sum of deposited amounts in the last 24 hours.
- Includes `contractId`, `name`, `recentDepositVolume` (sum as string).
- Returns `[]` if no deposits occurred recently.

### 4. `GET /api/v1/vaults/new` (#643)
- Returns vaults created within the given number of days (1–30, default 7).
- Accepts `days` query param to adjust the window.
- Returns the same vault shape as `GET /api/v1/vaults`.

## Verification

- `npm run lint` — clean (0 errors, 0 warnings)
- `npm run build` — success
- `npm run test` — all unit tests pass (2 pre-existing E2E failures require database)
- New routes registered before `/:contractId` to avoid Express route conflicts
