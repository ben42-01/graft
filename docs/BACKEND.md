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
- Stable machine-readable error codes (`VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `EMAIL_NOT_VERIFIED`, `NOT_FOUND`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `CONFLICT`, `INTERNAL`).
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
- Body size limits (1 MB JSON default; uploads via signed URLs, not through the API).
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
  /security       rate-limit-429.bru, forbidden-cross-tenant.bru, invalid-jwt.bru
  environments/   local.bru, ci.bru, staging.bru
```

Rules:
- Every endpoint has at least: happy path, validation failure, authz failure, **cross-tenant access attempt (must 404/403)**.
- Assertions on status, error `code`, envelope shape, and rate-limit headers.
- `bru run` executes in CI (GitHub Actions) against docker-compose (app + Mongo + Redis); a failed contract test blocks merge.
- Bruno tests double as the **API contract** referenced by agent issues (see AGENTS.md): an issue is "done" when its listed Bruno tests pass.

### 7.3 CI Pipeline (GitHub Actions)

1. lint + typecheck → 2. unit → 3. integration → 4. build → 5. spin ephemeral stack → 6. `bru run` → 7. Playwright smoke → 8. deploy preview.
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
