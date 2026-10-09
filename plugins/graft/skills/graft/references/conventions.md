# Conventions

_The response envelope, errors, pagination, ids, money and rate limits._

## Response envelope

Every successful response:

```json
{ "data": { "…": "…" }, "meta": { "requestId": "req_…" } }
```

Lists add paging information to `meta`. `204` responses have no body.

## Errors

Every failure has the same shape, with a stable machine-readable `code`:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid request body",
    "details": { "source": "body", "fields": { "email": "Not a valid email" } },
    "requestId": "req_…"
  }
}
```

Switch on `code`, not on `message`. Quote the `requestId` when you contact support.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | The request was well-formed JSON but not valid. `details.fields` names the problem fields. |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token. |
| `FORBIDDEN` | 403 | Signed in, but your role can't do this. |
| `EMAIL_NOT_VERIFIED` | 403 | Correct credentials, but the email isn't verified yet. |
| `FEATURE_NOT_AVAILABLE` | 403 | Your plan doesn't include this capability. `details.feature` names it. Offer an upgrade. |
| `QUOTA_EXCEEDED` | 403 | The capability is included but you have used it up. `details` carries `meter`, `limit` and `used`. |
| `NOT_FOUND` | 404 | No such thing in your workspace. |
| `CONFLICT` | 409 | The request clashes with current state: an illegal order transition, or capacity already taken. |
| `PAYLOAD_TOO_LARGE` | 413 | Body over the 1 MB JSON limit. |
| `ROW_LIMIT_EXCEEDED` | 400 | An import file had more rows than your plan allows per batch. |
| `RATE_LIMITED` | 429 | Too many requests. See `Retry-After`. |
| `INTERNAL` | 500 | Our fault. The message is deliberately generic; send us the `requestId`. |

Unknown fields in a request body are rejected, not ignored.

## Pagination

List endpoints are cursor-paginated:

```
GET /api/v1/orders?limit=25&cursor=eyJpZCI6…
```

`limit` defaults to 25 and is capped at 100. The response's `meta` has `limit`, `hasMore` and `cursor`. Pass `cursor` back to get the next page, and stop when `hasMore` is `false`. Cursors are opaque; don't build or edit them. An invalid cursor is `400 VALIDATION_FAILED`.

## Ids, money and time

- Ids are 24-character hex strings.
- Money is an integer in **minor units** (cents) with a `currency`. `15000` with `EUR` is €150.00. The server computes every total; you never send one.
- Timestamps are UTC ISO 8601.
- Field keys, entity keys and form slugs are lowercase: letters, digits and underscores for keys, letters, digits and single dashes for slugs.

## Rate limits

Limits are layered. The tightest applies.

| Scope | Limit |
|---|---|
| Per IP, all traffic | 300 requests/minute |
| Per workspace, authenticated API | Free 60/min, Premium 600/min, Enterprise 6,000/min |
| Sign-in attempts | 5 failures per 15 minutes per IP and email |
| Public form submission | 10/minute per IP and form |

Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds). A refused request is `429` with `Retry-After` in seconds. Back off for at least that long.

## Uploads

Files never pass through the API. Each upload is three steps:

1. `POST …/media` with `contentType` and `sizeBytes`. You get a presigned `uploadUrl` valid for 5 minutes.
2. `PUT` the bytes straight to `uploadUrl`.
3. `POST …/media/{mediaId}` to confirm. Graft verifies the object, charges storage and attaches it.

Images must be JPEG, PNG or WebP (SVG is refused). Import files are CSV or JSON, up to 25 MB.

## Idempotency and retries

Creating requests don't accept an idempotency key yet, so retrying a `POST` that timed out can create a duplicate. Read before you retry.
