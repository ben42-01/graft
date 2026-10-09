# Invoices

_Invoices issued against orders._

Invoices issued against orders.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/invoices`

List invoices. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`. Filter with `orderId` and `status` (draft, open, paid, void).

**Auth:** Bearer token

## `POST` `/api/v1/invoices`

Issue an invoice against an order. `kind` is `full`, `deposit` or `balance`.

**Auth:** Bearer token

**Request body**

```json
{
  "orderId": "000000000000000000000050",
  "kind": "deposit",
  "dueInDays": 14
}
```

## `GET` `/api/v1/invoices/:invoiceId`

One invoice.

**Auth:** Bearer token · **Path parameters:** `invoiceId`

## `PATCH` `/api/v1/invoices/:invoiceId`

Mark an invoice `paid` or `void`.

**Auth:** Bearer token · **Path parameters:** `invoiceId`

**Request body**

```json
{
  "status": "paid"
}
```
