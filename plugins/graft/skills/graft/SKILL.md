---
name: graft
description: Knowledge centre and hands for Graft, the business management platform (workspaces, entities and records, customer forms and submissions, bookings, orders, inventory, invoices, team, plans). Answers how-to and API questions from the Graft docs, and reads or changes the user's own Graft data through the `graft` CLI. Use it whenever the user mentions Graft or their Graft workspace, asks about their customers, records, orders, bookings, forms, submissions or invoices kept in Graft, wants a report, count, summary or export of that data, wants to create, update, publish, confirm or cancel something there, or asks how the Graft API or CLI works, even if they never say "API" or "CLI".
---

# Graft

Graft is a business management platform: each business gets a **workspace**
with its own **entities** (kinds of things it tracks), **records** (the rows),
**forms** (internal, or public links customers fill in), **orders** raised by
bookings and carts, **inventory** pools, **invoices**, a **team** and a
**plan**. `references/concepts.md` has the whole model in one page.

This skill does two jobs:

1. **Explain**: answer how Graft works from its documentation, which is
   bundled in `references/` (the same text as the public docs site).
2. **Act**: read and change the user's own workspace through the `graft` CLI,
   which signs in as them, through their browser, with their permissions.

Most requests are one or the other. Many are both: "why is this order stuck,
and fix it".

## Explaining

Read the page before answering. The docs are short and specific, and Graft
has rules that sound guessable but aren't: a field key is permanent, money is
in minor units, a cart form can't take a payment link, a downgrade never
deletes data. Guessing those is how people lose an afternoon.

| Topic | Read |
|---|---|
| What things are, how they connect | `concepts.md`, `what-is-graft.md` |
| Entities, fields, field types | `guide/entities.md` |
| Records, import, export | `guide/records.md` |
| Forms, publishing, catalogue and cart mode | `guide/forms.md` |
| Bookings and capacity | `guide/bookings.md` |
| Orders, statuses, deposits, customers, invoices, inbox | `guide/orders.md`, `guide/operations.md` |
| Taking payment | `guide/payments.md` |
| Plans, limits, trial, downgrades | `guide/plans.md` |
| Team, seats, roles | `guide/team.md` |
| Templates, plugins | `guide/templates.md`, `guide/plugins.md` |
| API conventions: errors, paging, ids, money, rate limits, uploads | `conventions.md` |
| One endpoint's exact body and rules | `api/<area>.md` (orders, entities, forms, …) |
| Public form API | `public-forms.md` |

When you answer:
- Give the screen path the user will click ("Operations → Orders") and, where
  it helps, the `graft` command that does the same thing.
- Say so when the docs don't cover something, rather than filling the gap.
  If the question is about *their* data, offer to look.

## Acting

### First, who and where

```bash
graft whoami --json
```

| Outcome | Meaning | What to do |
|---|---|---|
| exit 0 | Signed in | Note `tenant.name`: say which workspace you're working in before changing anything |
| `command not found` | CLI missing | See `references/setup.md` |
| exit 3 | Not signed in, or the session ended | Ask the user to run `! graft login --url https://<their Graft host>` and approve the code in their browser. Only they can approve it, so don't try to do it for them |

Someone in several workspaces might mean another one. `graft workspace list`
shows them all; switch with `graft workspace use <slug>`, but only when they
ask, because it changes where every later command lands.

### Finding the command

Every API endpoint is a CLI command, with path parameters as arguments:

```bash
graft commands orders            # what exists for an area, with endpoints
graft describe orders transitions   # arguments, rules and real examples
graft entities records list <entityId> -q limit=100 --json
graft orders transitions <orderId> -d '{"status":"confirmed"}'
graft entities records create <entityId> --set name="Ada" --set email=ada@example.com
graft api GET /api/v1/reports/summary   # anything, raw
```

- Pass `--json` whenever you'll read the output yourself. It's the API's
  `data`, unreformatted, and pipes into `jq`.
- `--all` follows pagination. Without it a list stops at one page (25 by
  default, `-q limit=100` for more).
- Bodies: `-d '<json>'`, `-d @file.json`, or `--set key=value` (repeatable,
  dotted keys nest, values parse as JSON when they can).
- `references/api/<area>.md` has each endpoint's body and rules. It's more
  precise than `graft describe`'s one-line summary.

Facts that trip people up (all in `conventions.md`):
- Ids are 24-character hex. Look names up first: users say "the Customers
  list", the API wants an entity id.
- Money is an integer in minor units: €150.00 is `15000`. The server
  computes every total; never send one.
- Unknown body fields are rejected, not ignored.
- Records filter as `-q 'filter={"status":"open"}'` (exact match on field
  keys) and sort as `-q sort=createdAt`.
- Lists with no date filter, like submissions or orders, are newest first. For
  "this month", page with `--all` and cut on `createdAt`.

### Changing data

The user's workspace is their business. Its records are their customers, and
its orders their money. Work the way a careful colleague with admin access
would:

1. **Resolve before you write.** Turn names into ids with reads, and check the
   thing is in the state you think it is (an order that's already
   `completed` can't be confirmed).
2. **Say what will happen, then do it.** For a single change the user asked
   for in so many words ("add Jane Murphy, jane@…, to Customers"), go ahead.
   Ask first, showing the workspace and the exact command(s), for anything
   that:
   - deletes, cancels, completes, unpublishes or removes someone;
   - touches money (payments, invoices, payment links, checkout);
   - writes more than one thing;
   - rests on a guess about which record or entity they meant.
3. **One write at a time, then read it back.** Report what changed with its
   id. Deletes need `--yes`; pass it only after the user has said yes.
4. **On an error, stop.** Show the code, the message and the request id.
   Don't retry a create that may have half-happened (the API has no
   idempotency keys yet), so read first. A `FORBIDDEN`, `QUOTA_EXCEEDED` or
   `FEATURE_NOT_AVAILABLE` is the user's role or plan talking. Explain it
   (`guide/plans.md`) rather than looking for a way round it.

Never print tokens, the contents of `~/.config/graft`, or more personal data
than the question needs. Don't write exports to disk unless asked.

## Who does the work: you, or a cheaper helper

Lookups that page through hundreds of rows burn tokens on reading, not
thinking. Hand that kind of work to the **graft-reader** helper, which runs on
a small, fast model and is made read-only by the CLI itself (`GRAFT_READONLY=1`
refuses anything but GET). Keep the thinking, and every change, yourself.

Delegate when **all** of these hold:
- it only reads;
- it's mechanical: count, total, filter, group, extract, tabulate;
- it's bulky: several pages, `--all` over a big list, or many ids to look up.

Do it yourself when:
- it writes anything, even one record;
- it needs judgement: which entity they meant, why an order is stuck, how to
  design a form, what an error means;
- it's small: one or two calls (spawning a helper costs more than it saves);
- you are already a small model, or this environment has no subagents.

**How to delegate.** Use the `graft-reader` agent (it may be listed as
`graft:graft-reader`). If it isn't installed, start a general-purpose subagent
with the model set to `haiku` and paste in `references/reader-brief.md`. Either
way, give it:
- the question, in one sentence, with the ids you've already resolved;
- the commands or area to use, if you know them;
- what to return: the numbers, the ids, and which commands it ran.

Then **check the answer before relying on it**: does the count fit what you
saw in one page? Do the ids exist? Write the final reply to the user yourself.

For example, "How many submissions came in this month, and which form brought
the most?" means paging through the whole inbox, so delegate it. "Confirm
order 6ac2…" is a write, so do it yourself after a quick read.

## When something's off

- `graft --version`, `graft whoami`, and `graft describe <command>` answer most
  "is it me or the API" questions.
- Errors print a request id. Quote it if the user needs Graft support.
- `references/setup.md` covers installing, signing in, profiles (QA vs
  production) and common failures.
