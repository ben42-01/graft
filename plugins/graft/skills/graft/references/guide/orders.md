# Orders, customers and invoices

_How a submission becomes a priced, tracked and invoiced job._

## Orders

An order is a priced piece of work: line items, a status and a payment record. Orders come from two places:

- A **booking or cart form** raises a draft order automatically.
- You can create one by hand in **Operations → Orders**.

### Line items

Each line has a kind, a quantity and a unit price:

| Kind | Meaning |
|---|---|
| Resource | The thing booked or sold |
| Add-on | An extra, such as life jackets |
| Fee | A charge, such as cleaning |
| Discount | Negative; the only kind that may be |

Graft computes every amount. Money is held in minor units (cents) with a currency.

### Status

```
draft ──► pending payment ──► confirmed ──► in progress ──► completed
  │              │               │               │
  └──────────────┴───────────────┴───────────────┴──► cancelled
```

A draft may also go straight to confirmed. **Completed** and **cancelled** are final. While an order is active (draft, pending payment, confirmed or in progress) it holds the capacity it reserved; cancelling releases it.

### Deposits and part payments

An order can carry a **deposit**. Record money received by hand as it arrives, such as cash or a bank transfer, with an optional reference. The **ledger** shows the order, every invoice against it and what is still owed.

## Customers

**Customers** are derived from orders: everyone who has ordered, with what they have spent. Open one to see their contact details, what they owe and every order they placed.

## Invoices

Invoicing is a Premium feature. Issue an invoice against an order as **full**, **deposit** or **balance**, with an optional due date. Mark it **paid** or **void**. Statuses are draft, open, paid and void.

## Inbox

**Operations → Inbox** lists every form submission, newest first, with the form it came through, who sent it and the order it raised.
