# Public forms

_The unauthenticated surface a visitor's browser uses: submit a form, browse its catalogue._

The unauthenticated surface a visitor's browser uses: submit a form, browse its catalogue.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/public/forms/:tenantSlug/:formSlug/catalogue`

One page of the records a published catalogue form shows visitors. Only the fields the form lists are returned. Page size is capped at 24.

**Auth:** None · **Path parameters:** `tenantSlug`, `formSlug`

## `POST` `/api/v1/public/forms/:tenantSlug/:formSlug/submissions`

Submit a published form. No authentication. `data` holds the field values; `_t` is the time the page rendered (ms since epoch) and `_hp` is a honeypot that must stay empty or absent. A catalogue form takes `_selection` (one record id); a cart form takes `_cart`, 1 to 20 lines of `{ recordId, quantity }`. Prices are never accepted from the client. Rate limited to 10 per minute per IP and form. Each accepted submission counts toward the monthly submission limit.

**Auth:** None · **Path parameters:** `tenantSlug`, `formSlug`

**Request body**

```json
{
  "data": {
    "customer": "Ada King",
    "starts_at": "2026-10-12T10:00:00Z"
  },
  "_t": 1790000000000,
  "_selection": "000000000000000000000039"
}
```

## `GET` `/api/v1/public/invites/:token`

What an invite landing page needs to say who invited you and to what role. Unauthenticated.

**Auth:** None · **Path parameters:** `token`

## `GET` `/api/v1/public/media/:mediaId`

Redirects (`307`) to a short-lived signed URL for a published form's image. Returns `404` once the form is unpublished.

**Auth:** None · **Path parameters:** `mediaId`
