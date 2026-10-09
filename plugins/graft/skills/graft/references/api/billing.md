# Billing

_Upgrade to Premium._

Upgrade to Premium.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `POST` `/api/v1/billing/checkout`

Start a Stripe Checkout session to upgrade to Premium. Owner only. Returns the URL to redirect to.

**Auth:** Bearer token

**Request body**

```json
{
  "plan": "monthly"
}
```
