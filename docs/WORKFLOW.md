# Graft — Development, QA & Production Workflow

**Doc:** GRAFT-DOC-01 · The first doc every developer (and agent) reads.
**Status:** Draft for review

This defines the three environments, the `package.json` command surface, the Dockerized MongoDB (with proper authentication from day one), and the seed/deploy scripts that spin the app up with mock or test data.

---

## 1. Environments

| Env | Purpose | Mongo | Data | URL |
|---|---|---|---|---|
| **dev** | local feature work | Docker `mongo:7`, auth enabled | rich mock data (faker) | localhost:3000 |
| **qa** | CI + manual QA, Bruno/Playwright runs | Docker `mongo:7` (ephemeral), auth enabled | deterministic test fixtures | localhost:3100 / CI |
| **prod** | live | MongoDB Atlas | real | graft.app |

Principles:

- **Auth everywhere, even locally.** Dev Mongo runs with `--auth` and a dedicated app user with `readWrite` on its own DB only — never root. This way connection-string handling, least-privilege, and auth failures behave identically to prod.
- **dev data is generative** (faker, realistic volume); **qa data is deterministic** (fixed IDs and values so Bruno assertions never flake).
- One command to a working stack: `npm run dev:full`.

---

## 2. Repository Layout (relevant parts)

```
/docker
  docker-compose.dev.yml
  docker-compose.qa.yml
  mongo-init/
    01-create-users.js        # creates app users with least privilege
/scripts
  seed-dev.ts                 # faker-based mock data
  seed-qa.ts                  # deterministic fixtures
  reset-db.ts                 # drop + reseed (guarded: refuses on prod URI)
  wait-for-mongo.ts           # readiness poll before app/seed starts
  create-indexes.ts           # idempotent index creation (also runs in prod deploy)
  migrate.ts                  # ordered migrations runner (migrations/ folder)
/bruno                        # API contract tests (see BACKEND.md)
/.env.example
/.env.dev                     # committed, no secrets (local docker creds only)
/.env.qa                      # committed, deterministic
/.env.production              # NEVER committed; from secret manager
```

---

## 3. package.json — Command Surface

```jsonc
{
  "name": "graft",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    // ── Development ─────────────────────────────────────────────
    "dev": "next dev",
    "dev:db": "docker compose -f docker/docker-compose.dev.yml up -d",
    "dev:db:down": "docker compose -f docker/docker-compose.dev.yml down",
    "dev:db:nuke": "docker compose -f docker/docker-compose.dev.yml down -v",
    "dev:seed": "tsx scripts/wait-for-mongo.ts && tsx scripts/seed-dev.ts",
    "dev:reset": "tsx scripts/reset-db.ts --env dev && npm run dev:seed",
    "dev:full": "npm run dev:db && npm run dev:seed && npm run dev",

    // ── QA ──────────────────────────────────────────────────────
    "qa:db": "docker compose -f docker/docker-compose.qa.yml up -d",
    "qa:db:down": "docker compose -f docker/docker-compose.qa.yml down -v",
    "qa:seed": "tsx scripts/wait-for-mongo.ts --env qa && tsx scripts/seed-qa.ts",
    "qa:app": "dotenv -e .env.qa -- next build && dotenv -e .env.qa -- next start -p 3100",
    "qa:full": "npm run qa:db && npm run qa:seed && npm run qa:app",

    // ── Quality gates ───────────────────────────────────────────
    "lint": "next lint && prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:api": "bru run bruno --env ci",
    "test:e2e": "playwright test",
    "verify": "npm run lint && npm run typecheck && npm run test && npm run test:integration",
    "verify:full": "npm run verify && npm run qa:db && npm run qa:seed && npm run test:api && npm run qa:db:down",

    // ── Database ops (all envs) ─────────────────────────────────
    "db:indexes": "tsx scripts/create-indexes.ts",
    "db:migrate": "tsx scripts/migrate.ts up",
    "db:migrate:status": "tsx scripts/migrate.ts status",

    // ── Build & release ─────────────────────────────────────────
    "build": "next build",
    "start": "next start",
    "release:check": "npm run verify:full && npm audit --audit-level=high"
  }
}
```

Key deps for this layer: `tsx`, `dotenv-cli`, `@faker-js/faker` (dev), `mongodb`, `vitest`, `@usebruno/cli`, `playwright`.

---

## 4. Dockerized MongoDB with Authentication

### 4.1 docker-compose.dev.yml

```yaml
services:
  mongo:
    image: mongo:7
    command: ["--auth"]
    ports: ["27017:27017"]
    environment:
      MONGO_INITDB_ROOT_USERNAME: graft_root
      MONGO_INITDB_ROOT_PASSWORD: dev_root_change_me
      MONGO_INITDB_DATABASE: graft_dev
    volumes:
      - graft_dev_data:/data/db
      - ./mongo-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "-u", "graft_root", "-p", "dev_root_change_me",
             "--eval", "db.adminCommand('ping')"]
      interval: 5s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

volumes:
  graft_dev_data:
```

QA compose is identical except: different container names, port `27018`, **no named volume** (ephemeral — `down -v` wipes it), and DB `graft_qa`.

### 4.2 mongo-init/01-create-users.js (least-privilege app user)

```js
// Runs once on first container start, as root, against MONGO_INITDB_DATABASE
db.createUser({
  user: "graft_app",
  pwd: "dev_app_change_me",
  roles: [{ role: "readWrite", db: db.getName() }] // app user: its DB only, no admin
});
```

### 4.3 Connection strings (.env files)

```bash
# .env.dev  (committed — local-only creds, still rotated by convention)
MONGODB_URI="mongodb://graft_app:dev_app_change_me@localhost:27017/graft_dev?authSource=graft_dev"
REDIS_URL="redis://localhost:6379"
JWT_PRIVATE_KEY_PATH=".keys/dev-jwt-private.pem"   # generated by postinstall, gitignored
NEXTAUTH_URL="http://localhost:3000"

# .env.qa
MONGODB_URI="mongodb://graft_app:qa_app_change_me@localhost:27018/graft_qa?authSource=graft_qa"

# .env.production (secret manager only)
MONGODB_URI="mongodb+srv://graft_prod_app:<secret>@<cluster>.mongodb.net/graft?retryWrites=true&w=majority"
```

Rule: **the app never knows root credentials** in any environment.

---

## 5. Seed & Deployer Scripts

### 5.1 seed-dev.ts (mock data via faker)

Creates a believable multi-tenant world so every plugin/UI has something to render:

- 3 tenants: `Bella's Barbershop` (free), `O'Shea Plumbing` (premium), `Shannon Logistics` (enterprise)
- Users per tenant (owner/admin/member) — password `Dev!12345`, printed at end of seed
- Per tenant: 2–4 `entity_defs` (Customers, Jobs, Bookings, Invoices), 50–500 `records` each (faker), 1–3 published Customer Forms with 20–200 `form_submissions`, dashboards with widgets, usage meters set near tier thresholds (to exercise 80% warnings in dev)
- Idempotent: tagged `seedBatch` field; re-running replaces prior seed data only.

### 5.2 seed-qa.ts (deterministic fixtures)

- Fixed ObjectIds (e.g. `000000000000000000000001`), fixed emails (`owner@qa-free.test`), fixed counts — Bruno assertions reference these directly.
- Includes edge-case tenants: one AT quota limit, one with a paused connector, one downgraded tenant with read-only over-limit entities.

### 5.3 reset-db.ts (guarded)

```
1. Load env, parse MONGODB_URI
2. HARD FAIL if host matches *.mongodb.net or NODE_ENV=production
3. Drop app collections, re-run create-indexes.ts, exit
```

### 5.4 wait-for-mongo.ts

Polls the connection with the app user until success (max 60s) — makes `dev:full`/CI deterministic instead of racing the container.

### 5.5 create-indexes.ts & migrate.ts

- `create-indexes.ts`: idempotent `createIndex` calls for every collection (safe to run every deploy).
- `migrate.ts`: ordered scripts in `/migrations`, applied once, recorded in a `_migrations` collection. This is the **same mechanism** dev, qa, and prod use — no snowflake prod migrations.

---

## 6. Daily Workflows

**Developer, day one:**
```bash
git clone … && npm i
cp .env.example .env.local   # defaults already point at docker dev
npm run dev:full             # db up → seeded → app on :3000
```

**Feature loop (matches AGENTS.md):** branch `GRAFT-NN-…` off `develop` → code + tests → `npm run verify` → push → CI runs `verify:full` → PR review → merge into `develop`.

**QA / CI:** `qa:db → qa:seed → build → start :3100 → test:api (Bruno) → test:e2e → teardown`. The QA stack is fully ephemeral; every run starts from identical fixtures.

**Prod deploy (summary — full detail in GO-LIVE.md):** promote `develop` → `main` → CI green → `db:migrate` + `db:indexes` against Atlas (release job, not app boot) → deploy to Vercel → smoke tests → tag.

---

## 7. Open Questions

- Testcontainers for integration tests vs reusing the qa compose stack?
- Do we want a `dev:seed --tenant <name>` targeted reseed for faster iteration?
- Local HTTPS (mkcert) now or when we start on secure-cookie edge cases?
