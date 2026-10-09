# Orders

_Orders, their lifecycle, payments and payment links._

Orders, their lifecycle, payments and payment links.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/orders`

List orders. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`. Filter with `status`, `customerRecordId`, `from` and `to`.

**Auth:** Bearer token

## `POST` `/api/v1/orders`

Create an order. Send line items with `kind` (`resource`, `addon`, `fee`, `discount`), `quantity` and `unitAmountMinor`; the server computes every amount. Money is integer minor units (cents) plus a currency code. A discount line is negative, every other kind is not.

**Auth:** Bearer token

**Request body**

```json
{
  "currency": "EUR",
  "customerRecordId": "000000000000000000000020",
  "lineItems": [
    {
      "kind": "resource",
      "description": "24ft pontoon, 4 hours",
      "quantity": 1,
      "unitAmountMinor": 60000
    }
  ],
  "deposit": null
}
```

## `GET` `/api/v1/orders/:orderId`

One order with its lines, totals and payments.

**Auth:** Bearer token · **Path parameters:** `orderId`

## `PATCH` `/api/v1/orders/:orderId`

Change the line items, deposit, notes or customer of an order that is still active.

**Auth:** Bearer token · **Path parameters:** `orderId`

## `DELETE` `/api/v1/orders/:orderId`

Delete an order that is still active and release what it reserved.

**Auth:** Bearer token · **Path parameters:** `orderId`

## `GET` `/api/v1/orders/:orderId/ledger`

The order, every invoice against it, and what is still outstanding.

**Auth:** Bearer token · **Path parameters:** `orderId`

## `PUT` `/api/v1/orders/:orderId/payment-link`

Attach a Stripe Payment Link (`https://buy.stripe.com/…`) or hosted invoice (`https://invoice.stripe.com/…`). Any other host is refused.

**Auth:** Bearer token · **Path parameters:** `orderId`

**Request body**

```json
{
  "url": "https://buy.stripe.com/test_abc123"
}
```

## `DELETE` `/api/v1/orders/:orderId/payment-link`

Remove the order's payment link.

**Auth:** Bearer token · **Path parameters:** `orderId`

## `POST` `/api/v1/orders/:orderId/payment-link/send`

Email the payment link to the order's customer from Graft. Replies go to the sender. No body.

**Auth:** Bearer token · **Path parameters:** `orderId`

## `POST` `/api/v1/orders/:orderId/payments`

Record money received by hand (cash, bank transfer).

**Auth:** Bearer token · **Path parameters:** `orderId`

**Request body**

```json
{
  "amountMinor": 15000,
  "reference": "Bank transfer 4421"
}
```

## `POST` `/api/v1/orders/:orderId/transitions`

Move the order through its lifecycle. Allowed: draft to pending_payment, confirmed or cancelled; pending_payment to confirmed or cancelled; confirmed to in_progress, completed or cancelled; in_progress to completed or cancelled. `completed` and `cancelled` are final. Anything else is `409 CONFLICT`.

**Auth:** Bearer token · **Path parameters:** `orderId`

**Request body**

```json
{
  "status": "confirmed"
}
```
