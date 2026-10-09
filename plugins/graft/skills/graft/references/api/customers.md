# Customers

_People who have ordered, derived from orders._

People who have ordered, derived from orders.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/customers`

Everyone who has ordered, with what they have spent. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`.

**Auth:** Bearer token

## `GET` `/api/v1/customers/:customerId`

One customer: contact details, what they have spent and owe, and every order.

**Auth:** Bearer token · **Path parameters:** `customerId`
