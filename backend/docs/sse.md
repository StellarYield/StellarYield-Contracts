# Server-Sent Events (SSE) Guide

The backend exposes five Server-Sent Events (`text/event-stream`) endpoints for real-time updates.

All streams emit standard SSE frames (`data: <json>\n\n`) using the default `message` event (no `event:` field is set, so `EventSource.onmessage` receives every frame), and are excluded from response compression in `backend/src/app.ts`.

## 1. Stream Endpoints & Payloads

### Vault Events Stream

- **Endpoint:** `GET /api/v1/vaults/stream`
- **Query Parameters:** `contractIds` (optional, comma-separated Stellar contract IDs `C[A-Z2-7]{55}`)
- **Auth:** Public (optional API key)
- **Handler:** `streamVaultEvents` (`backend/src/api/controllers/vaults.ts`) via `SseManager.addVaultClient` (`backend/src/services/sseManager.ts`)
- **Frame Format:** `id: <number>\ndata: <json>\n\n`
- **Payload Fields:**
  - `contractId` (`string`) — Stellar vault contract ID
  - `type` (`string`) — Event type
  - `payload` (`object`) — Event-specific fields

### Indexer Progress Stream

- **Endpoint:** `GET /api/v1/admin/indexer/stream`
- **Auth:** Required (admin router)
- **Handler:** `streamIndexerProgress` (`backend/src/api/controllers/admin.ts`) via `SseManager.addIndexerClient` (`backend/src/services/sseManager.ts`)
- **Frame Format:** `data: <json>\n\n`
- **Payload Fields:**
  - `lastLedger` (`number`) — Latest processed Stellar ledger sequence
  - `eventsProcessed` (`number`) — Number of events processed in the tick
  - `tickDurationMs` (`number`) — Tick duration in milliseconds

### Yields Stream

- **Endpoint:** `GET /api/v1/yields/stream`
- **Query Parameters:** `contractId` (optional) — subscribes the client to epoch events for that vault
- **Auth:** Public; subject to `sseLimitPerIp()` when unauthenticated
- **Handler:** `getYieldsStream` (`backend/src/api/controllers/yields-stream.ts`) via `sseService` (`backend/src/services/sse.ts`)
- **Payload Fields** (`EpochRecordedEvent`):
  - `type`: `"epoch_recorded"`
  - `contractId` (`string`)
  - `epoch` (`number`)
  - `yieldAmount` (`string`)
  - `timestamp` (`string`, ISO 8601)

### Webhook Delivery Stream

- **Endpoint:** `GET /api/v1/webhooks/:id/stream`
- **Path Parameters:** `id` (positive integer webhook ID)
- **Auth:** Required (`webhooksRouter`); subject to `sseLimitPerIp()`
- **Handler:** `getWebhookStream` (`backend/src/api/controllers/webhooks-stream.ts`) via `sseService` (`backend/src/services/sse.ts`)
- **Payload Fields** (`WebhookDeliveryEvent`):
  - `type`: `"delivery"`
  - `attempt` (`number`)
  - `statusCode` (`number | null`)
  - `durationMs` (`number`)
  - `success` (`boolean`)

### User Positions Stream

- **Endpoint:** `GET /api/v1/users/:address/stream`
- **Path Parameters:** `address` (Stellar user address)
- **Auth:** Public
- **Handler:** `streamUserPositions` (`backend/src/api/controllers/users.ts`)
- **Payloads:**
  - Initial snapshot (sent immediately on connect):
    - `type`: `"initial"`
    - `portfolio` (`object`) — User's current portfolio from `userService.getUserPortfolio(address)`
  - Position update:
    - `type`: `"position_updated"`
    - `vaultContractId` (`string`)
    - `shares` (`string`)
    - `deposited` (`string`)

## 2. Heartbeat Intervals

| Stream | Heartbeat Frame | Interval | Configuration |
| --- | --- | --- | --- |
| `GET /api/v1/vaults/stream` | `: ping\n\n` | `15000` ms (default) | `SSE_HEARTBEAT_MS` (`backend/src/config.ts`) |
| `GET /api/v1/admin/indexer/stream` | `: ping\n\n` | `15000` ms (default) | `SSE_HEARTBEAT_MS` (`backend/src/config.ts`) |
| `GET /api/v1/yields/stream` | `:keep-alive\n\n` | `30000` ms (plus once on connect) | Hardcoded in `yields-stream.ts` |
| `GET /api/v1/webhooks/:id/stream` | `:keep-alive\n\n` | `30000` ms (plus once on connect) | Hardcoded in `webhooks-stream.ts` |
| `GET /api/v1/users/:address/stream` | None | — | — |

## 3. Reconnection with `Last-Event-ID`

Only `GET /api/v1/vaults/stream` assigns event IDs and supports `Last-Event-ID` replay (`backend/src/services/sseManager.ts`):

- Each vault event receives a monotonically increasing per-vault integer `id` (`id: <n>`).
- The latest ID per vault is persisted in Redis (`sse:vault:{contractId}:lastEventId`, TTL `30` days) so counters survive process restarts.
- Up to `SSE_REPLAY_BUFFER` events per vault (default `100`, configured in `backend/src/config.ts`) are retained in an in-memory ring buffer.
- On reconnect, if the client sends the `Last-Event-ID` request header (done automatically by browser `EventSource`), the server replays all buffered events with `id > Last-Event-ID` for the subscribed `contractIds` (or all buffered vaults if `contractIds` is omitted). Gaps larger than `SSE_REPLAY_BUFFER` are not fully recoverable.

## 4. Per-IP Connection Limit

`sseLimitPerIp()` (`backend/src/api/middleware/sseLimitPerIp.ts`) is applied to:
- `GET /api/v1/yields/stream`
- `GET /api/v1/webhooks/:id/stream`

Rules:
- **Limit:** `SSE_MAX_CONNECTIONS_PER_IP` (default `5` concurrent unauthenticated connections per client IP, resolved from `X-Forwarded-For` or `req.ip`).
- **Authenticated bypass:** Requests with a valid API key (`req.apiKey`) are exempt from the per-IP limit.
- **429 Response:** When the limit is reached, the server responds with `429 Too Many Requests`, `Retry-After: 60` (`SSE_RETRY_AFTER_SECONDS`), and:

```json
{
  "error": "TooManyRequests",
  "message": "Too many SSE connections from this IP. Limit: 5"
}
```

## 5. Browser `EventSource` Example

```javascript
const url = "/api/v1/vaults/stream?contractIds=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const source = new EventSource(url);

source.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Vault event", event.lastEventId, data.contractId, data.type, data.payload);
};

source.onerror = () => {
  // EventSource automatically reconnects and sends the Last-Event-ID header.
  console.warn("SSE connection lost; waiting for automatic reconnect...");
};
```
