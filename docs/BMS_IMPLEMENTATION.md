# BMS Extension — Implementation Notes

**Companion to `docs/BMS_EXTENSION.md`** (the specification) and
`docs/BACKEND.md`.

The specification is written against a relational schema — tables, UUID primary
keys, JSONB columns, foreign keys. Graft is MongoDB. This document records what
was actually built, and every place the implementation deliberately departs
from the spec.

Covers **all four steps**: schema, the inventory and reservation engine,
invoicing, and the operational command dashboard.

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

## 6a. Orders and invoicing (Step 3)

### Money

Integer **minor units** everywhere (`docs/BACKEND.md` §2). No float arithmetic
touches a total.

Rates on a record are authored in *major* units, because that is what a human
types into a form — `hourly_rate: 150` means €150.00 — so `toMinor` is the
single boundary where that becomes `15000`, and it rounds exactly once, at the
edge. Everything downstream is integers.

Rounding directions are deliberate and each is tested on its own:

| Rule | Direction | Why |
|---|---|---|
| Major → minor | nearest | `12.345` is not a price anyone means to charge; resolve it once rather than refusing it. |
| Duration → billable units | **up** | Four hours and one minute of a boat is five billable hours. Rounding down gives away 59 minutes. |
| Percentage deposit | **down** | A deposit is a *part* of a total. A part that rounds up can exceed a sequence of parts that must sum to the whole. |
| Order total | floored at 0 | A discount larger than the order is a data error, not a refund nobody authorised. |

Zero-decimal currencies (JPY, KRW) are deliberately **not** special-cased:
doing it correctly needs a currency-exponent table, and a wrong table is worse
than a consistent one. Amounts are stored in hundredths throughout; a
zero-decimal currency is a display concern.

### The order state machine

```
draft → pending_payment → confirmed → in_progress → completed
  └──────────────┴──────────────┴────────────┴──────→ cancelled
```

The transition table is **data, not `if` statements**, so "can an order go from
completed back to draft" has one answer in one place. An illegal move is a 409
that names both states *and lists what is allowed from here*, so a client never
has to guess the graph.

Two transitions have consequences beyond the document:

- **`confirmed` confirms the order's allocations** — and does so **first**. If
  a hold lapsed while the customer was paying, the confirmation fails and the
  order stays where it was. An order that says "confirmed" while the boat it
  booked has quietly lapsed is the worst failure this subsystem can have.
- **`cancelled` releases them**, best-effort: an allocation someone already
  released is not a reason to leave the order stuck in a state the business has
  decided is over.

### Payments

`amountPaidMinor` only ever goes up, and only through `recordPayment`, which
uses `$inc` + `$push` rather than read-modify-write — a webhook retry landing
beside a manual entry must add up, not overwrite.

**Confirmation is a consequence, not a request.** A payment provider knows how
much arrived and nothing more; whether that is enough is decided against the
order's own deposit (or its total, when there is no deposit).

### Invoices

- **A snapshot, not a view.** Line items, totals and currency are copied at
  issue time. Rendering from the live order would let a later edit rewrite a
  document someone has already received.
- **Numbers are sequential and gapless**, per tenant per year
  (`INV-2026-0001`), allocated by an atomic `$inc` on a counter document — not
  by counting rows, which races and would miscount as soon as one was voided.
  A unique index on `(tenantId, number)` is the backstop.
- **A deposit invoice and a balance invoice always sum to the order.** The
  balance is computed from the *deposit*, not from what has actually been paid,
  so a part-paid deposit cannot inflate the balance above the agreed price.
- **`void` is the only way back.** An issued invoice is never edited and never
  deleted; a wrong one is voided and replaced.

### API surface (Step 3)

```
GET    /api/v1/orders                                 ?status=
POST   /api/v1/orders                                 priced once, starts as draft
GET    /api/v1/orders/:orderId
PATCH  /api/v1/orders/:orderId                        draft only
DELETE /api/v1/orders/:orderId                        cancels, then soft-deletes
POST   /api/v1/orders/:orderId/transitions            the state machine's only door
POST   /api/v1/orders/:orderId/payments               record money received
GET    /api/v1/orders/:orderId/ledger                 order + invoices + outstanding

GET    /api/v1/invoices                               ?orderId= &status=
POST   /api/v1/invoices                               kind: full | deposit | balance
GET    /api/v1/invoices/:invoiceId
PATCH  /api/v1/invoices/:invoiceId                    paid | void — nothing else
```

### Not done in Step 3

**Stripe is not wired to orders.** `src/app/api/v1/webhooks/stripe/**` is a
protected path in `.github/agent-policy.yml` and needs explicit human approval.
The seam is ready and provider-agnostic: `recordPayment(ctx, orderId, {
amountMinor, reference })` is everything a `payment_intent.succeeded` handler
would need to call, and it already drives the confirmation. Wiring it is a
handful of lines in the webhook route plus a checkout-session endpoint that
stamps the order id into the session metadata.

---

## 6b. The Operational Command Dashboard (Step 4)

One screen, `/operations`, with three views. It is **composed from endpoints
that already exist** — orders, allocations and pools are three plain reads —
rather than from a bespoke `/dashboard` endpoint returning a shape only this
screen understands. A view with its own server contract goes stale the first
time anything else changes.

### Pipeline (Kanban)

- **Drag-and-drop is not the only way to move a card.** Native HTML5 drag
  events are unusable with a keyboard and largely invisible to a screen reader,
  so every card carries a "Move to" select listing exactly the transitions the
  server allows. The pointer path is a convenience over that, not a replacement.
- **The moves offered come from the server's own transition table**, mirrored in
  the component, so the board cannot suggest something the API will refuse.
- **Moves are optimistic and revert on refusal**, with the reason shown. The
  optimistic state is *kept* on success and cleared only when a genuinely new
  list arrives from the server — clearing it immediately would snap the card
  back until the refetch landed.
- Column colours are deliberately **not** a red/green good/bad scale. A
  cancelled order is a normal business outcome, and colouring it as an error
  makes a board of ordinary work look alarming.

### Schedule (master timeline)

- **Buffer blocks are drawn, not hidden.** A bar spans `blockedFrom`–
  `blockedUntil` with the turnaround hatched. A scheduler showing only booked
  hours makes the gaps look bookable when they are not — the exact question
  this view exists to answer.
- **Every bar is a real button with a text label** naming the resource, both
  times, the quantity and the turnaround. A timeline of coloured `div`s is
  invisible to anyone not looking at it.
- **Colour never carries the only meaning**: a hold is marked by a dashed
  outline *and* the word "Hold", not by hue.
- Bars are positioned in percentages of the visible window, so it is a CSS
  layout that reflows rather than a canvas that must be redrawn.

### Today (daily dispatch)

Four panels, each something someone has to *do*: starting today, out now, due
back today, money owed. Counts nobody acts on belong on a dashboard widget, not
here. `buildDispatch` is pure and runs against the viewer's own clock, so the
day boundary is theirs rather than the server's.

**"Unsigned waivers" (§2.3) is deliberately absent.** A waiver is a
tenant-defined form field, not a platform concept; inventing a `waiverSigned`
flag would bake one business's compliance model into the product. It belongs to
the Forms plugin once a form can be marked required-before-collection.

### Also in this step: the Plugins screen

Not part of §2.3, but `/api/v1/plugins/*` had shipped with no screen over it —
which reads as a broken product rather than an unfinished one, since a tenant
could be told their plan includes every plugin and have nowhere to turn one on.
A plugin the tier does not permit is **shown, disabled, with the reason and a
route to upgrade**, following the existing `GatedControl` pattern.

---

## 7. Where the guarantees are proven

| Claim | Evidence |
|---|---|
| Overlap and buffer arithmetic | `src/server/services/availability.test.ts` (28 tests) |
| Pool strategy/quantity rules, immutable strategy | `src/server/services/inventory.test.ts` (17 tests) |
| No double-booking under real concurrency | `src/server/services/availability.integration.test.ts` — 8 simultaneous holds on one asset, 12 on a capacity of 3, against `MongoMemoryReplSet` |
| Cross-tenant isolation | same file, plus `bruno/inventory/tenant-isolation.bru` |
| The HTTP contract end to end | `bruno/inventory/*.bru` (11 requests) against the QA stack |
| Money arithmetic and every rounding rule | `src/server/services/pricing.test.ts` (33 tests) |
| The order state machine and payment rules | `src/server/services/orders.test.ts` (27 tests) |
| Invoice snapshotting, splitting and voiding | `src/server/services/invoices.test.ts` (21 tests) |
| Booking → payment → confirmation, end to end | `src/server/services/orders.integration.test.ts` |
| **Gapless invoice numbering under concurrency** | same file — 10 invoices issued simultaneously produce 0001–0010, no gaps, no duplicates |
| The orders/invoices HTTP contract | `bruno/orders/*.bru` (11 requests) |
| Dispatch partitioning (starting / out now / due back / owed) | `src/components/operations/daily-dispatch.test.tsx` (14 tests) |
| Kanban accessibility, optimistic move and revert | `src/components/operations/order-board.test.tsx` (10 tests) |
| Timeline labels, buffers and hold distinction | `src/components/operations/resource-timeline.test.tsx` (9 tests) |
| The plugins screen, including tier gating | `src/app/(app)/plugins/page.test.tsx` (7 tests) |
