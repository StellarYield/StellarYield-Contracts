# API Error Codes

All API error responses include a `code` field for programmatic error handling.

## Error Response Format

```json
{
  "code": "ERROR_CODE",
  "message": "Human-readable error description",
  "statusCode": 404
}
```

## Error Codes

### VAULT_NOT_FOUND (404)
The requested vault contract ID does not exist in the database.

**Example:** `GET /api/v1/vaults/UNKNOWN_ID`

### USER_NOT_FOUND (404)
The requested user address does not exist in the database.

**Example:** `GET /api/v1/users/GUNKNOWN...`

### VALIDATION_ERROR (400)
Request validation failed (invalid parameters, missing required fields, etc).

### UNAUTHORIZED (401)
Authentication required but not provided or invalid.

### RATE_LIMITED (429)
Too many requests. Rate limit exceeded for this endpoint. See [rate-limits.md](./rate-limits.md) for tier limits, response headers, and `429` response details.

### RPC_ERROR (500)
Failed to communicate with the Stellar blockchain RPC node.

### WEBHOOK_INVALID (400)
Webhook payload validation failed or signature mismatch.

### NOT_FOUND (404)
Generic not found error for resources.

### INTERNAL_SERVER_ERROR (500)
An unexpected server error occurred.

### SERVICE_UNAVAILABLE (503)
The database could not be reached. Responses carry `Retry-After` (seconds) and
clients should back off for that long before retrying. Public vault list and
detail reads may instead return the last successful copy, with
`X-Cache: STALE` and `Warning: 110`, for up to `STALE_TTL_SECONDS` (default 600).

### Rate-limit and retry headers

Every 429 carries `Retry-After`: for a window limit it counts down to the window
reset, and for an IP lockout it is the lockout period. A 503 always carries
`Retry-After` (30 seconds by default).

## Usage in Client Code

```typescript
try {
  const vault = await fetch('/api/v1/vaults/CAB...');
  const data = await vault.json();
} catch (err) {
  if (err.code === 'VAULT_NOT_FOUND') {
    // Handle vault not found
  } else if (err.code === 'RATE_LIMITED') {
    // Implement backoff/retry
  }
}
```
