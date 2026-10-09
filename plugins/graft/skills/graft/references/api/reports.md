# Reports

_Headline numbers, sales and usage._

Headline numbers, sales and usage.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/reports/sales`

Sales over a window: a daily series, best sellers, orders by form and repeat customers. The full report needs the Premium `reports` feature; without it the call is `403 FORBIDDEN` naming the feature.

**Auth:** Bearer token

## `GET` `/api/v1/reports/summary`

The Overview's headline numbers: open orders, what is owed, the last 30 days against the 30 before.

**Auth:** Bearer token

## `GET` `/api/v1/reports/usage`

Usage data for the chart widget. Needs the Premium `reports` feature, otherwise `403 FORBIDDEN`.

**Auth:** Bearer token
