# Inventory

_Bookable pools, availability, holds and allocations._

Bookable pools, availability, holds and allocations.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/inventory/allocations`

The allocations the master schedule reads. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`.

**Auth:** Bearer token

## `PATCH` `/api/v1/inventory/allocations/:allocationId`

Confirm a hold, release it, or cancel a confirmed booking.

**Auth:** Bearer token · **Path parameters:** `allocationId`

## `DELETE` `/api/v1/inventory/allocations/:allocationId`

Release an allocation.

**Auth:** Bearer token · **Path parameters:** `allocationId`

## `GET` `/api/v1/inventory/pools`

List bookable pools. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`. Filter with `entityId`.

**Auth:** Bearer token

## `POST` `/api/v1/inventory/pools`

Make a record bookable. `strategy` is `individual_asset` (one unique unit), `pooled_quantity` (stock of N) or `time_slot` (concurrent capacity). `bufferMinutes` blocks turnaround time between bookings.

**Auth:** Bearer token

**Request body**

```json
{
  "entityId": "000000000000000000000015",
  "recordId": "000000000000000000000039",
  "strategy": "pooled_quantity",
  "totalQuantity": 50,
  "bufferMinutes": 30
}
```

## `GET` `/api/v1/inventory/pools/:poolId`

One pool.

**Auth:** Bearer token · **Path parameters:** `poolId`

## `PATCH` `/api/v1/inventory/pools/:poolId`

Change quantity, buffer or auto-lock.

**Auth:** Bearer token · **Path parameters:** `poolId`

**Request body**

```json
{
  "totalQuantity": 60
}
```

## `DELETE` `/api/v1/inventory/pools/:poolId`

Delete a pool.

**Auth:** Bearer token · **Path parameters:** `poolId`

## `GET` `/api/v1/inventory/pools/:poolId/availability`

What is free in a time window, after buffers and existing allocations.

**Auth:** Bearer token · **Path parameters:** `poolId`

## `POST` `/api/v1/inventory/pools/:poolId/holds`

Place a time-limited hold on capacity so two customers can't book the same slot. A hold that would overbook is `409 CONFLICT`.

**Auth:** Bearer token · **Path parameters:** `poolId`
