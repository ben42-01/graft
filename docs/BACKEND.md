# Graft — Backend API Best Practices & Security Spec

**Doc:** GRAFT-DOC-03 · Companion to `README.md`
**Status:** Draft for review

---

## 1. Architectural Principles

1. **Thin routes, fat services.** Next.js Route Handlers only parse/validate/authenticate, then delegate to a service layer (`/src/server/services/*`). Business logic never lives in a route file.
2. **Tenant isolation is non-negotiable.** Every service function takes an authenticated `ctx = { tenantId, userId, roles }`. Every Mongo query is scoped by `tenantId`. A repository layer enforces this so it cannot be forgotten:
   ```ts
   // repositories always inject tenantId — services cannot bypass it
   recordsRepo.find(ctx, entityDefId, filter)  // internally: { tenantId: ctx.tenantId, ...filter }
   ```
3. **Validate at the boundary.** Zod schemas for every request body/query/params. For dynamic entities, Zod schemas are compiled from `entity_defs` at request time (cached per tenant + entity version).
4. **Idempotency** for unsafe operations that may be retried (payments, CSV imports, connector syncs): accept `Idempotency-Key` header, store result hash for 24h.
5. **Everything is observable.** Structured JSON logs (pino) with `requestId`, `tenantId`, `userId`; no PII in logs. Metrics + tracing (OpenTelemetry) from day one.

## 2. API Design Conventions

- Base path: `/api/v1/...` — versioned from the start.
- REST resource style, plural nouns: `/api/v1/entities/:entityId/records`.
- Standard envelope:
  ```json
  { "data": ..., "meta": { "page": 1, "pageSize": 25, "total": 312 } }
  ```
  Errors (RFC 7807-inspired):
  ```json
  { "error": { "code": "QUOTA_EXCEEDED", "message": "...", "details": {...}, "requestId": "..." } }
  ```
- Stable machine-readable error codes (`VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `EMAIL_NOT_VERIFIED`, `NOT_FOUND`, `QUOTA_EXCEEDED`, `FEATURE_NOT_AVAILABLE`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `ROW_LIMIT_EXCEEDED`, `CONFLICT`, `INTERNAL`).
  `FEATURE_NOT_AVAILABLE` is a 403 distinct from `QUOTA_EXCEEDED`: the capability
  is not on the tenant's plan at all, so the client's remedy is an upgrade prompt
  naming the feature rather than "wait until next period" (GRAFT-25.1 AC1).
  `ROW_LIMIT_EXCEEDED` is a 400 distinct from `PAYLOAD_TOO_LARGE`: the request
  body was small and well-formed, the *file it named* had more rows than the tier
  allows in one batch (GRAFT-25.1 AC2).
  `EMAIL_NOT_VERIFIED` is a 403 distinct from `FORBIDDEN`: the credentials were
  correct and the account simply is not usable yet, which is a state the client
  offers a specific remedy for (GRAFT-03.2 AC3).
- Cursor-based pagination for large collections (`?cursor=...&limit=`), offset pagination allowed for small admin lists.
- Filtering/sorting via a constrained query grammar — never pass raw client filters into Mongo (NoSQL injection). Whitelist fields from `entity_defs`.
- All timestamps UTC ISO-8601; money as integer minor units + currency code.

## 3. Authentication & Authorization

### 3.1 JWT Strategy

- **Access token:** short-lived JWT (15 min), signed **RS256/EdDSA** (asymmetric — API nodes verify with public key, only auth service holds the private key). Claims:
  ```json
  { "sub": userId, "tid": tenantId, "roles": [...], "tier": "premium", "iat", "exp", "jti" }
  ```
- **Refresh token:** opaque, httpOnly + Secure + SameSite=Lax cookie, 30 days, **rotated on every use**; reuse detection revokes the whole token family (stolen-token defense).
- Access token delivered to the browser app via httpOnly cookie as well (not localStorage — XSS-safe); `Authorization: Bearer` supported for the public API / connectors.
- Key rotation via JWKS endpoint; `kid` in header. Revocation: short expiry + a small deny-list (jti) in Redis for logout-everywhere.
- Multi-tenant switching: user picks tenant → new access token minted with that `tid`. One token = one tenant, always.

### 3.2 Authorization

- RBAC: roles per tenant (`owner`, `admin`, `member`, plugin-defined roles). Enforced in the service layer via `assertPermission(ctx, "records:write", entityDefId)`.
- Entitlements (tier gating) checked alongside permissions: `can(ctx, "csv_import")`.
- Public form endpoints (`POST /api/v1/public/forms/:slug/submissions`) are the **only** unauthenticated write surface — see §5.

#### Platform admin — a second boundary, not a role (GRAFT-27.1)

`/api/v1/admin/*` is authorised by `assertPlatformAdmin(ctx, …)`
(`src/server/auth/platform-admin.ts`), which is **not** part of tenant RBAC and
must not be confused with the tenant role also called `admin`. The two are
independent: the most privileged tenant role grants nothing on this surface, and
the platform flag grants nothing inside a tenant.

- **Where it lives.** `isPlatformAdmin: true` on the `users` document. `Ctx` is
  not extended and `ROLES` is not widened — the privilege belongs to a person,
  not to a seat in a workspace, so no tenant-scoped code path changes meaning.
- **Never on the token.** The flag is absent from `accessClaimsSchema` and is
  re-read from the database on **every** admin request. A privilege carried on a
  15-minute access token is one you cannot revoke for 15 minutes. Same argument
  as re-reading roles on refresh (§3.1) and never trusting `ctx.tier` for a
  grant.
- **Compared with `=== true`.** `"true"`, `1`, `{}` and `"false"` are all truthy
  in JavaScript and none of them is a grant. The raw value is normalised once,
  in `toUser` (`src/server/auth/accounts-store.ts`).
- **Refusals are `404 NOT_FOUND`, never `403 FORBIDDEN`.** A deliberate
  divergence from the cross-tenant refusals in §2: a 403 would confirm to an
  ordinary tenant user that the admin surface exists and which of its paths are
  real. The refusal reuses the /api/v1 catch-all's exact message, so it is
  indistinguishable from an unrouted path.
- **Not tenant-scoped, and not tier-gated.** An admin request still carries a
  `ctx` (there is no tenant-less login), but it is used for identity, logging
  and rate-limit accounting only. `ctx.tenantId` is never a filter on this
  surface, `createRepository` is never called, and `can()` / `checkQuota()` are
  never consulted.
- **`admin_audit_log`** is append-only and global (not tenant-scoped). One row
  per **successful** gate pass, holding `actorUserId`, `action`,
  `targetTenantId | null`, `requestId`, `at` — and no PII (§8). Denials are a
  plain `admin.denied` log line instead: an audit log that records attempts is
  one any caller can grow.
- **Granting** is `npm run admin:grant -- <email>` (`--revoke` to clear). There
  is no self-service path and no HTTP endpoint, by design.

##### Endpoints on this surface

| Endpoint | Audit action | Notes |
| --- | --- | --- |
| `GET /api/v1/admin/session` | `admin.session.read` | The console's gate probe (GRAFT-27.1). Exposes no tenant data. |
| `GET /api/v1/admin/tenants?q=&tier=&limit=&cursor=` | `admin.tenants.list` | Every tenant in the database, cursor-paginated (`DEFAULT_LIMIT` 25 / `MAX_LIMIT` 100). `q` matches `name`/`slug` case-insensitively and is regex-escaped before it reaches Mongo; an unknown `tier` is a `400 VALIDATION_FAILED`, never an empty list (GRAFT-27.2). |
| `GET /api/v1/admin/tenants/:tenantId` | `admin.tenants.read` | One tenant's tier, resolved entitlements, override bag, `readOnly`, `downgradedAt`, `billingAnchorDay`. Non-24-hex is `400`; unknown id is `404` (GRAFT-27.2). |

Both tenant reads go through an allow-list serialiser in
`src/server/services/admin-tenants.ts` — every emitted field is named, there is
no `...tenant` spread anywhere in the module, and billing is reported as the
booleans `hasCustomer` / `hasSubscription`. **No Stripe identifier, secret or
email address is ever in a response body on this surface**, and that is asserted
directly (`bruno/security/admin-no-stripe-ids-leaked.bru`, plus a unit test over
the serialiser) rather than left to review.

`tenants` is a global collection keyed by `_id` and is read directly here, as it
already is by `entitlements.ts`, `billing.ts` and `auth/accounts-store.ts`: the
repository layer scopes *by* `tenantId` and therefore cannot fetch a tenant at
all. The consequence is that the repository is not protecting these reads —
`assertPlatformAdmin` is the only thing that is.

## 4. Rate Limiting & Abuse Protection

Layered, Redis-backed (sliding window or token bucket via `rate-limiter-flexible`):

| Scope | Key | Example limit |
|---|---|---|
| Global IP | ip | 300 req/min |
| Auth endpoints | ip + email | 5 login attempts / 15 min, exponential backoff |
| Authenticated API | tenantId | tier-based: Free 60/min, Premium 600/min, Ent custom |
| Per-user | userId | 120/min |
| Public form submit | ip + formId | 10/min + CAPTCHA after threshold |
| Connectors / API tokens | tokenId | tier-based |

- Respond `429` with `Retry-After` and `X-RateLimit-Limit/Remaining/Reset` headers.
- Body size limits (1 MB JSON default; uploads via signed URLs, not through the API). An over-sized body is refused with `413 PAYLOAD_TOO_LARGE` before the handler runs.
- **Uploads are two calls plus a direct PUT** (implemented in `src/server/storage/s3.ts` and `src/server/services/media.ts`): `POST …/media` records intent and returns a presigned `PUT` (5 min TTL); the browser uploads straight to the bucket; `POST …/media/:mediaId` re-reads the object with a `HEAD`, charges `storage_mb` in whole megabytes and promotes the row to `ready`. Bytes never pass through a route handler, so the 1 MB JSON ceiling above stays a real ceiling. Content types are an **allow-list** of raster formats — `image/svg+xml` is refused, since an SVG served to anonymous visitors is a script host.
- **Batch record import reuses that pattern exactly** (GRAFT-25.1,
  docs/TIERS.md §2.3): `POST /api/v1/entities/:entityId/import-uploads` mints the
  presigned PUT for a `text/csv` or `application/json` file (25 MB ceiling),
  `POST …/import-uploads/:mediaId` confirms it, and only then does
  `POST /api/v1/entities/:entityId/imports` — which receives a `mediaId`, never
  bytes — parse it. `GET /api/v1/entities/:entityId/imports/:importId` re-reads
  one result. All four are gated on `can(ctx, "csv_import")` and are limited by
  the authenticated-API scopes above (`global-ip`, `api`, `user`).
  In `mapping`, a source column mapped to `null` is skipped — its cells are never
  read. An unmentioned column still maps to itself. The client gates its import
  UI on `GET /api/v1/me` → `tenant.features.csv_import`, which is the resolved
  entitlement (tier plus per-tenant override), never on `tenant.tier`.
- **Buckets are private in every environment.** Reads go through the application (`GET /api/v1/public/media/:mediaId`), which 307s to a presigned `GET` (1 h TTL) only while the *owning* resource is public — a form's images go dark the moment it is unpublished or killed. MinIO in dev and QA, any S3-compatible endpoint in production, so the signed-URL path is identical everywhere.
- Auth endpoints are charged on **failure**: a correct password never spends the 5-per-15-minutes budget.
- When Redis is unavailable the limiter fails **closed** on the unauthenticated write surfaces (public form, auth) and **open** on authenticated traffic and the global IP layer, logging `ratelimit.degraded` with the decision either way.
- Security headers via middleware: HSTS, CSP, X-Content-Type-Options, frame-ancestors.
- CORS: locked to app origins; public form embed endpoints get a separate permissive-but-scoped policy.
- CSRF: SameSite cookies + double-submit token on cookie-authenticated mutations.

## 5. Public Form Hardening

- Honeypot field + minimum-fill-time check + optional Turnstile/hCaptcha.
- Server-side validation against the form's compiled Zod schema; reject unknown fields.
- Spam scoring before counting toward quota.
- Per-form kill switch and per-tenant emergency unpublish.
- Uploaded files scanned (ClamAV or provider scanning), stored in quarantine bucket until clean, served via signed URLs only.

## 6. Data Layer Practices

- Mongoose (or native driver + Zod) with **schema versioning** on `entity_defs` (`schemaVersion` on each record; lazy migration on read/write).
- Compound indexes: `records(tenantId, entityDefId, updatedAt)`, plus per-tenant promoted searchable fields.
- Multi-document transactions for cross-collection invariants (e.g., submission → record + meter increment).
- Soft deletes (`deletedAt`) for tenant data; hard-delete job for GDPR erasure requests.
- Backups: Atlas continuous backup; restore drills quarterly.
- Secrets in environment/secret manager, never in the repo; connector credentials encrypted at rest (AES-256-GCM, per-tenant data key).

## 7. Testing Strategy

### 7.1 Pyramid

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | services, validators, entitlement logic, meter math |
| Integration | Vitest + mongodb-memory-server (or Testcontainers) | repositories, service flows, tenant isolation |
| **API contract / E2E** | **Bruno** | every endpoint, run in CI against an ephemeral stack |
| UI E2E | Playwright | onboarding, form builder, public form submit |
| Load | k6 | public form submit, records list at tier limits |

### 7.2 Bruno Conventions

Bruno collections live in-repo at `/bruno` (git-native, reviewable in PRs):

```
/bruno
  /auth           login.bru, refresh.bru, refresh-reuse-detection.bru
  /entities       create.bru, list.bru, update.bru, tenant-isolation.bru
  /records        crud.bru, pagination.bru, filter-whitelist.bru
  /forms          publish.bru, public-submit.bru, quota-hard-stop.bru
  /connectors     create.bru, sync-idempotency.bru
  /security       rate-limit-429.bru, forbidden-cross-tenant.bru, invalid-jwt.bru,
                  admin-surface-is-not-an-oracle.bru
  /admin          session.bru, session-not-admin.bru, session-no-token.bru
  environments/   local.bru, ci.bru, staging.bru
```

Rules:
- Every endpoint has at least: happy path, validation failure, authz failure, **cross-tenant access attempt (must 404/403)**.
- `/bruno/admin` (GRAFT-27.1) inverts the isolation rule rather than skipping it: those endpoints are deliberately not tenant-scoped, so the required test is that a caller *without* the platform flag — including a tenant `owner`/`admin` — is refused.
- Assertions go in `assert {}` or a **synchronous** `test()` body. An `async` test body does not fail the Bruno gate, so an assertion inside one is not a test.
- Assertions on status, error `code`, envelope shape, and rate-limit headers.
- `bru run` executes in CI (GitHub Actions) against docker-compose (app + Mongo + Redis); a failed contract test blocks merge.
- Bruno tests double as the **API contract** referenced by agent issues (see AGENTS.md): an issue is "done" when its listed Bruno tests pass.

### 7.3 CI Pipeline (GitHub Actions)

1. lint + typecheck → 2. unit → 3. integration → 4. build → 5. spin ephemeral stack → 6. `bru run` → 7. deploy preview.

Playwright e2e (`docs/BACKEND.md` §7.2 "UI E2E" row) exists in `e2e/` but is deliberately not wired into this pipeline yet — the UI is still in active flux; re-add once it stabilizes.
- Coverage gate 80% on services; dependency audit (`npm audit` + Dependabot); secret scanning (gitleaks); SAST (CodeQL).

## 8. Operational Readiness

- `/api/health` (liveness) and `/api/ready` (Mongo/Redis checks).
- Sentry for error tracking with tenant tagging.
- Feature flags for risky rollouts.
- Runbooks: rate-limit storm, quota bug, token-family revocation, connector credential leak.

## 9. Decisions & Open Questions

**Decided — auth (2026-08-15):** hand-rolled RS256 exactly as specified in §3.1 — no
Auth.js, no Clerk. Rationale: §3.1's refresh rotation with reuse detection and
one-token-one-tenant is the security model we want, the Bruno contract tests already
assume it (`/auth/refresh-reuse-detection.bru`), and a session vendor would own the
part of the system we least want to hand over. Cost accepted: Enterprise SSO/SAML in
Phase 3 is ours to build. Supersedes the open question below.

**Decided — REST everywhere:** no tRPC. Bruno is the API contract, and a public API
is a Phase 3 deliverable; a second internal protocol would fork the contract surface.

Still open:

- Redis: Upstash (serverless-friendly on Vercel) vs self-managed?
