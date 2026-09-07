# BMS Extension — Implementation Notes

**Companion to `docs/BMS_EXTENSION.md`** (the specification) and
`docs/BACKEND.md`.

The specification is written against a relational schema — tables, UUID primary
keys, JSONB columns, foreign keys. Graft is MongoDB. This document records what
was actually built, and every place the implementation deliberately departs
from the spec.

Covers **Steps 1–2** (schema + the inventory and reservation engine). Steps 3
and 4 append here as they land.

---

## 1. Relational spec → document model

| Spec | Graft | Why |
|---|---|---|
| `BusinessEntity` (one layer) | `entity_defs` (schema) **+** `records` (instance) | Graft's model has two layers where the spec has one. §3.2's example pool is named "24ft Pontoon Boat" and carries an hourly rate — that is an *instance*, not a schema. So **a pool attaches to a record**, one per record, and `entityDefId` is denormalised onto the pool so "every bookable thing of this type" stays an indexed query rather than a join Mongo will not do. |
| `InventoryPool` table | `inventory_pools` collection | Plus `allocationVersion` — see §3. |
| `ResourceAllocation` table | `resource_allocations` collection | Plus `blockedFrom` / `blockedUntil` — see §2. |
| `strategy_type` SCREAMING_CASE | `individual_asset` / `pooled_quantity` / `time_slot` | The codebase's existing enum convention (`FieldType`, `Visibility`, `Meter` are all lower-snake). A second convention for one enum would be noise. |
| FK constraints | Tenant-scoped repository + explicit checks | Mongo has no foreign keys. `src/server/repositories/base.ts` injects `tenantId` into every query, so another tenant's pool is 404 rather than 403. |
| Index on `(entity_id, start_time, end_time)` | `(tenantId, poolId, blockedFrom, blockedUntil)` | `tenantId` leads every index in this codebase — the isolation boundary is also the index prefix. The pool is a tighter prefix than the entity (a pool belongs to exactly one entity type), and the range is over the *blocked* window because that is what an overlap actually means. |
| `Decimal` money | Integer minor units + currency code | `docs/BACKEND.md` §2. Arrives with Step 3. |

---

## 2. Buffer Time Engine (§2.1)

Buffers are **baked into the stored allocation at write time**:

```
blockedFrom  = startAt - bufferMinutes
blockedUntil = endAt   + bufferMinutes
```

so an overlap test is a plain range comparison an index can serve. Reading the
buffer at query time instead would mean every availability check re-derives it
for every candidate row, and a later buffer change would silently rewrite
history.

Two rules that are easy to get wrong and are pinned by tests:

- **The buffer is applied to the stored side only, never to the request.**
  Applying it to both would double the gap — 30 minutes of cleaning after a
  booking plus 30 before the next is an hour nobody configured.
- **Ranges are half-open, `[startAt, endAt)`.** A 10:00–12:00 booking and a
  12:00–14:00 booking do not overlap. Anything else makes back-to-back slots
  un-bookable at every boundary.

The buffer lives on the **pool**, not the allocation: it is a property of the
resource, and putting it on the booking would let two hires of the same boat
disagree about how long it takes to clean.

---

## 3. Pessimistic Time-Locking — and the trap in it

A hold runs inside a MongoDB transaction, which gives **snapshot isolation**.
That is *not sufficient* for this problem.

Two concurrent transactions can both read "capacity 1, used 0" and both insert
a **different** allocation document. Different documents means no write
conflict, both commit, and the boat is double-booked. This is **write skew**,
and snapshot isolation does not prevent it.

The fix: every hold also writes the **shared pool document** inside the same
transaction (`$inc: { allocationVersion: 1 }`). Now the two transactions
contend on one document, exactly one commits, and `withTransaction` retries the
loser — which re-reads and correctly sees the first allocation.

> **Nothing reads `allocationVersion`.** It looks like a redundant write and is
> not. `src/server/services/availability.integration.test.ts` was run with that
> `$inc` removed against a real replica set, and **7 of 8 concurrent holds took
> the same single asset**. Any write to the pool document would serialise;
> `$inc` is chosen because it is monotonic and says what it is for.

---

## 4. Expired holds

An expired hold is **invisible, not deleted**. Availability filters on
`expiresAt`, so a lapsed checkout stops blocking the instant it lapses, with no
sweeper in the loop.

A TTL index reclaims the rows *a day after* the lease ends, not at it —
correctness never waits for the TTL monitor, and the day's grace keeps
abandoned checkouts readable for anyone asking why a customer did not finish
one. Confirmed rows carry `expiresAt: null`, which the TTL monitor skips.

Same convention as `refresh_tokens` (`docs/BACKEND.md` §3.1).

---

## 5. API surface (Steps 1–2)

```
GET    /api/v1/inventory/pools                        list; ?entityId= narrows to one type
POST   /api/v1/inventory/pools                        create (one pool per record)
GET    /api/v1/inventory/pools/:poolId
PATCH  /api/v1/inventory/pools/:poolId                capacity, buffer, lock — never strategy
DELETE /api/v1/inventory/pools/:poolId                soft delete; allocations survive

GET    /api/v1/inventory/pools/:poolId/availability   the is_available API of §2.1
POST   /api/v1/inventory/pools/:poolId/holds          the pessimistic time-lock

GET    /api/v1/inventory/allocations                  the master schedule; ?poolId= &from= &to=
PATCH  /api/v1/inventory/allocations/:allocationId    confirm | release | cancel
DELETE /api/v1/inventory/allocations/:allocationId    release
```

`GET .../availability` is deliberately read-only and racy: the answer is true
at the instant it is given and nothing more. It exists so a UI can grey out a
date without taking a lock. A checkout that needs the answer to *stay* true
posts a hold, which asks the same question again inside a transaction.

`GET /allocations` filters on the **blocked** window, so a timeline drawn from
it shows buffer blocks as the occupied time they actually are.

---

## 6. Deliberate deviations from the spec

- **`strategy` is immutable.** Changing it would silently reinterpret every
  allocation already written against the pool — a pooled booking of 4 kayaks
  has no meaning once the pool claims to be one named asset — and no migration
  is right for both readings. Delete the pool and create the right one.
- **`totalQuantity` is normalised, not validated.** An `individual_asset` is
  forced to a quantity of 1 rather than rejected for declaring 7: the caller is
  describing a specific boat, and "how many of this boat are there" is not a
  question they should have had to answer.
- **Deleting a pool leaves its allocations alone.** They are the record of what
  happened to the resource, and a business that retires a boat still needs last
  season's bookings to be readable.
- **Capacity is summed, not counted.** A pooled allocation of 4 kayaks takes 4
  of the 50, not 1 of the 50. For an `individual_asset` pool every row is
  quantity 1 against a capacity of 1, so the same arithmetic yields the boolean
  the strategy implies without a second code path.

---

## 7. Where the guarantees are proven

| Claim | Evidence |
|---|---|
| Overlap and buffer arithmetic | `src/server/services/availability.test.ts` (28 tests) |
| Pool strategy/quantity rules, immutable strategy | `src/server/services/inventory.test.ts` (17 tests) |
| No double-booking under real concurrency | `src/server/services/availability.integration.test.ts` — 8 simultaneous holds on one asset, 12 on a capacity of 3, against `MongoMemoryReplSet` |
| Cross-tenant isolation | same file, plus `bruno/inventory/tenant-isolation.bru` |
| The HTTP contract end to end | `bruno/inventory/*.bru` (11 requests) against the QA stack |
