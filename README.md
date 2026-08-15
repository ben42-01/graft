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

Sign-in fixtures: `owner@bellas-barbershop.test` / `Dev!12345` (seed prints them all).

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

## How Graft gets built

Humans set direction, agents draft contracts, implement them from a queue, and
soft-review the result. GitHub is the single source of truth. The three roles are
Claude Code skills in [.claude/skills/](.claude/skills):

- `/graft-draft` — rough intent → a contract issue, parked for human approval
- `/graft-build` — claim the top queued issue → branch, tests-first, PR
- `/graft-review` — soft review a PR against its contract

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

---

*Graft — graft together the business system that fits you.*
