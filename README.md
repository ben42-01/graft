# Graft

**A generic, plugin-driven Business Management System for local and medium-sized businesses.**

Instead of forcing every business into the same rigid CRM/ERP mold, Graft gives each
customer a composable workspace: they enable plugins, define their own entities, build
forms, and share public Customer Forms as adverts. See [docs/Graft.md](docs/Graft.md).

## Quickstart

```bash
npm install          # also generates .env.dev / .env.qa and JWT keys (gitignored)
npm run dev:full     # docker db up → indexes → seed → app on :3000
```

That's it. `dev:full` leaves you with three seeded tenants — a free-tier barbershop
parked at 85% of its submission quota, a premium plumbing company, and an enterprise
logistics firm — and a status page confirming Mongo and Redis are reachable.

Sign-in fixtures: `owner@bellas-barbershop.test` / `Dev!12345678` (seed prints them all).

## Commands

| Command | What it does |
|---|---|
| `npm run dev:full` | Everything: db → seed → dev server |
| `npm run dev:reset` | Drop the dev database and reseed (guarded: refuses non-local hosts) |
| `npm run dev:db:nuke` | Remove containers **and volumes** — use after rotating credentials |
| `npm run verify` | lint + typecheck + unit + integration |
| `npm run verify:full` | `verify`, then the QA stack + Bruno contract tests, then teardown |
| `npm run qa:full` | Ephemeral QA stack with deterministic fixtures on :3100 |
| `npm run db:migrate` | Apply pending migrations (same runner in dev, qa and prod) |

## Environments

| Env | Mongo | Data | URL |
|---|---|---|---|
| dev | docker `mongo:7`, auth on, port 27017 | generative (faker) | localhost:3000 |
| qa | docker `mongo:7`, auth on, port 27018, ephemeral | deterministic fixtures | localhost:3100 |
| prod | Atlas | real | graft.app |

Mongo runs with `--auth` even locally, and the app connects as a least-privilege user
with `readWrite` on its own database only — it never holds root credentials in any
environment. Full rationale in [docs/WORKFLOW.md](docs/WORKFLOW.md).

### Secrets

No credential is committed. `npm run setup` generates `.env.dev`, `.env.qa` and an
RS256 keypair with per-machine random values; the docker compose files interpolate
them at runtime. Only `.env.example` — placeholders, no values — is tracked.

### Email

Graft sends its email (verification, team invites, order payment links) over SMTP,
configured by `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`
(see `.env.example`). With them unset, every message is printed to the app's stdout
as a `mail.logged` line instead — that is how dev, QA and CI run.

To send through a Gmail account: turn on 2-Step Verification, create an App Password
at <https://myaccount.google.com/apppasswords> (one per environment), and put it in
that environment's env file with `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=465`.
Gmail sends from your own address only and caps a consumer account at roughly 500
recipients a day; replies go to the business through Reply-To.

## Hosted QA on the Raspberry Pi

A checklist of everything the Pi needs, in one place. Written from the repo, not yet
walked through on the Pi itself — fix whatever turns out to differ.

**1. Machine**

- 64-bit OS, Node 20+, Docker with the compose plugin, git.
- `mongo:7` needs an ARMv8.2 CPU: a Pi 5 is fine, a Pi 4 is not (use a 4.4 image or
  point `MONGODB_URI` at Atlas instead).
- The MinIO image is digest-pinned in `docker/docker-compose.qa.yml` (GRAFT-32):
  confirm that digest has an `arm64` manifest. It runs as uid 65532, so the data
  volume must be writable by it.

**2. App**

```bash
git clone <repo> && cd graft && npm install   # generates .env.qa and JWT keys
```

Edit `.env.qa` (it is gitignored; `npm run setup` will not overwrite an existing file):

| Variable | Set to |
|---|---|
| `APP_URL` | The public tunnel URL, no trailing slash — every email link, Stripe return URL and invite link is built from it |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | Gmail App Password (see [Email](#email)); unset = mail only logged to stdout |
| `STRIPE_SECRET_KEY` | A real **test-mode** `sk_test_…` (the generated one is a dummy) |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | From the two dashboard endpoints in step 4 — different values |
| `STRIPE_PRICE_PREMIUM_MONTHLY` / `_ANNUAL` | Real test-mode price ids |

Then `npm run qa:full` (db → indexes → fixtures → build → app on :3100). Note that
`qa:db:down` deletes the volumes, so this stack is ephemeral by design. For a Pi that
should keep its data, run the compose file without `-v`.

**3. Public URL**

The app keeps listening on `localhost:3100`; the tunnel sits in front of it.

- Tailscale: `tailscale funnel 3100` gives `https://<host>.<tailnet>.ts.net`.
- Cloudflare Tunnel (prod): point the hostname at `http://localhost:<port>`.

Put that URL in `APP_URL` and restart (env is read once at startup). Smoke test:
sign up → open the verification link from the email → log in → confirm the session
cookie sticks over HTTPS.

**4. Stripe (test mode)**

Because the funnel is publicly reachable, the **Stripe CLI is not needed** on the Pi —
use dashboard endpoints (full detail in [docs/STRIPE.md](docs/STRIPE.md)):

1. Dashboard (test mode) → Connect → *Get started*, once.
2. Developers → Webhooks → add `https://<APP_URL host>/api/v1/webhooks/stripe-connect`,
   listening to **Events from connected accounts**: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `account.updated`. Copy its signing
   secret to `STRIPE_CONNECT_WEBHOOK_SECRET`.
3. Add a second endpoint `…/api/v1/webhooks/stripe` (Premium billing) and copy its
   secret to `STRIPE_WEBHOOK_SECRET`.
4. Restart the app. Deliveries should show `200` on each endpoint's page in Stripe.

The CLI (`stripe listen --forward-connect-to …`) is only for a laptop without a
public URL.

**5. Afterwards**

`npm run db:migrate` and `npm run db:indexes` on any database that is not freshly
created by `qa:full`.

## How Graft gets built

Humans set direction, agents draft contracts, implement them from a queue, and
soft-review the result. GitHub is the single source of truth. The three roles are
Claude Code skills in [.claude/skills/](.claude/skills):

- `/graft-draft` — rough intent → a contract issue, parked for human approval
- `/graft-build` — claim the top queued issue → branch, tests-first, PR
- `/graft-review` — soft review a PR against its contract
- `/graft-merge` — on your say-so, merge the PRs that qualify and report the ones that don't

Guardrails (protected paths, WIP and diff limits, the security checklist) live in
[.github/agent-policy.yml](.github/agent-policy.yml). Loop spec:
[docs/AGENTS.md](docs/AGENTS.md).

### Branches

`develop` is the default branch and the base for all work; `main` is the release
branch and only ever receives `develop` through a `type:release` contract. Work
branches are named after their issue (`GRAFT-14-bugfix/form-quota-off-by-one`) and
deleted after merge.

## Docs

| Doc | |
|---|---|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Environments, commands, docker, seeds — read first |
| [docs/Graft.md](docs/Graft.md) | Product concept and architecture |
| [docs/TIERS.md](docs/TIERS.md) | Free / Premium / Enterprise limits and enforcement |
| [docs/BACKEND.md](docs/BACKEND.md) | API conventions, auth, rate limiting, testing |
| [docs/AGENTS.md](docs/AGENTS.md) | The agentic development loop |
| [docs/GO-LIVE.md](docs/GO-LIVE.md) | Production launch checklist |

## Yeah, you can watch Playwright run in a real browser instead of headless. From the repo root:

npx playwright test e2e/pricing.spec.ts --headed

That opens an actual Chromium window and drives it through the test steps. A few useful variants:

- npx playwright test --headed --workers=1 — run the whole suite headed, one at a time (matches how CI now runs it after GRAFT-21).
- npx playwright test e2e/pricing.spec.ts --debug — headed and pauses with Playwright's Inspector so you can step through action-by-action.
- npx playwright test --ui — the nicest option: opens Playwright's UI Mode, a full time-travel debugger where you see every test, every step, and a live/replayed browser pane, with the DOM snapshot at each point.

One prerequisite: the app needs to be running against a seeded QA stack first (these specs hit real API routes and fixture users like owner@qa-free.test). The repo has npm run

---

*Graft — graft together the business system that fits you.*
