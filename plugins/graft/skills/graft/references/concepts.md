# Core concepts

_Workspaces, entities, records, forms, orders, inventory and dashboards, and how they connect._

Graft has a few moving parts and they fit together in one direction:

**a form writes records, an entity holds them, a dashboard reads them.**

## Workspace

Your business's own space in Graft, also called a tenant. Everything you create belongs to exactly one workspace and is invisible to every other. A person can belong to several workspaces and switch between them.

## Entity

A **kind of thing you track**: customers, jobs, bookings, products. You give it a name and a list of fields. An entity holds no data itself; it is the shape the data takes.

## Record

**One row under an entity's shape**: one customer, one job. The form for adding a record is generated from the entity's fields, and required fields are enforced before anything is saved.

## Form

A **page that writes records into one entity**. A form can be:

- **Internal**: for you and your team.
- **Public**: a link anyone can open and submit without an account. Public forms start as drafts and go live when you publish. Nobody filling one in can read what is already there.

Each submission arrives as a record you can see and edit like any other.

## Orders

A submission can raise an **order**: priced line items, a status that moves from draft to completed, and a payment record. Orders feed your customers list, invoices, and reports.

## Inventory

Anything that can be booked or sold in limited supply can become a **pool** with a capacity. Graft checks availability, holds slots while a customer checks out, and protects against double-booking.

## Dashboards

**Widgets** that read your records back out: a list of the latest rows, a number to watch, a calendar, a chart.

## Plugins and templates

- A **plugin** switches on a capability, and may create the entities and forms it needs.
- A **workspace template** sets a whole workspace up for a type of business in one step.

## Plans

Every workspace is on **Free**, **Premium** or **Enterprise**. The plan sets limits (entities, records, forms, submissions, seats, storage) and unlocks features. See [Plans and limits](../../guide/plans/).
