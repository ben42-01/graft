# Graft — Go-Live Readme

**Doc:** GRAFT-DOC-05 · The production launch checklist. Nothing ships until every REQUIRED item is checked.
**Status:** Draft for review

Legend: 🔴 REQUIRED for launch · 🟡 required within 30 days of launch · 🟢 nice-to-have

---

## 1. Infrastructure

- 🔴 **MongoDB Atlas** production cluster (M10+), dedicated `graft` DB
  - `graft_prod_app` user: `readWrite` on `graft` only; separate `graft_migrator` user for release jobs; **no root/admin usage by the app**
  - IP access list restricted to hosting egress / VPC peering — never 0.0.0.0/0
  - Continuous backups enabled + point-in-time recovery; **restore tested once before launch**
  - Region: EU (Ireland) for data residency
- 🔴 **Vercel** production project: prod + preview environments separated, prod env vars locked to production only
- 🔴 **Redis** (Upstash or equivalent) for rate limiting, token deny-list, meters cache — TLS on
- 🔴 Custom domain `graft.app` + `www` redirect, TLS, HSTS preloaded; public forms domain path live (`/f/...`)
- 🔴 All secrets in the platform secret manager; `.env.production` exists nowhere on disk or in git (verify with gitleaks scan)
- 🟡 Staging environment on Atlas free/shared tier mirroring prod topology

## 2. Database Go-Live

- 🔴 `npm run db:migrate` + `npm run db:indexes` wired into the release pipeline (run **before** app deploy, with `graft_migrator`)
- 🔴 All compound indexes from BACKEND.md §6 created and verified with `explain()` on the heaviest queries (records list, submissions insert)
- 🔴 Connection pooling sized for serverless (maxPoolSize tuned; single cached client per lambda)
- 🔴 `reset-db.ts` guard verified: refuses Atlas hosts (test this!)
- 🟡 Slow query profiler alerts (>100ms) in Atlas

## 3. Security (gate: no launch without all 🔴)

- 🔴 JWT: RS256 keys generated in secret manager, JWKS endpoint live, refresh rotation + reuse detection verified by Bruno tests in CI
- 🔴 Rate limiting active on: auth endpoints, public form submissions, authenticated API (tier-based) — verified with k6 hitting 429s
- 🔴 Public form hardening live: honeypot, min-fill-time, CAPTCHA threshold, spam scoring, file quarantine (BACKEND.md §5)
- 🔴 Security headers (HSTS, CSP, X-Content-Type-Options, frame-ancestors) verified via securityheaders.com scan
- 🔴 CORS locked to production origins; CSRF double-submit on cookie-authenticated mutations
- 🔴 Cross-tenant isolation Bruno suite green against a prod-like build (the single most important test we have)
- 🔴 Dependency audit clean at high severity; CodeQL + gitleaks in CI
- 🔴 Admin/ops access: 2FA enforced on GitHub, Vercel, Atlas, Stripe, DNS registrar
- 🟡 External penetration test / at minimum a structured internal red-team pass on the public form surface
- 🟡 Vulnerability disclosure policy page (`/.well-known/security.txt`)

## 4. Payments & Tiers

- 🔴 Stripe live mode: products/prices for Premium (monthly/annual) + add-ons match TIERS.md §3
- 🔴 Webhooks (`checkout.session.completed`, `subscription.updated/deleted`, `invoice.payment_failed`) verified with Stripe CLI against prod endpoint; signature verification on
- 🔴 Entitlement enforcement tested end-to-end: upgrade → limits raise immediately; downgrade → graceful read-only behavior (nothing deleted)
- 🔴 Quota meters: 80% warning email + 100% hard-stop verified on a test tenant
- 🔴 Stripe Tax configured (EU VAT); business entity + terms of sale finalized
- 🟡 Dunning emails for failed payments; 7-day grace period job

## 5. Legal & Compliance

- 🔴 Privacy Policy + Terms of Service published and linked from sign-up (explicit consent checkbox)
- 🔴 GDPR: data export per tenant, erasure flow (soft-delete → hard-delete job), DPA template for business customers; Records of Processing started
- 🔴 Cookie consent (only if non-essential cookies exist — aim to need none)
- 🔴 Public form submitters (our customers' customers) covered: per-form privacy notice line + data controller identification (the tenant) — this is a legal must, we are the processor
- 🟡 Data retention policy documented (submissions, audit logs, backups)

## 6. Observability & Operations

- 🔴 Sentry (or equivalent) wired with release tagging + tenant tagging, alert rules to Slack/email
- 🔴 Structured logs shipping (pino → log drain); no PII in logs verified
- 🔴 `/api/health` + `/api/ready` monitored by an external uptime checker (60s interval) with alerting
- 🔴 Dashboards: request rate, p95 latency, error rate, Mongo connections, Redis hit rate, submissions/min, 429 rate
- 🔴 Runbooks committed: incident response, rollback procedure, token-family revocation, rate-limit storm, quota bug, connector credential leak (BACKEND.md §8)
- 🔴 Rollback tested: previous Vercel deployment promotion + migration down-path (or forward-fix policy documented)
- 🟡 Status page (public) with component-level status
- 🟡 On-call rotation (even if it's a rotation of one) with escalation doc

## 7. Product Readiness

- 🔴 Full onboarding flow (README §3) passes Playwright E2E on prod build: sign-up → verify email → wizard → plugins → first entity → first form → publish → public submission received
- 🔴 Transactional email live (verification, password reset, quota warnings, submission notifications) with SPF/DKIM/DMARC passing
- 🔴 The 3 MVP plugins (Contacts, Forms, Scheduling-basic) feature-complete per their issue contracts
- 🔴 OG cards render correctly for shared Customer Form links (test on WhatsApp/X/Facebook debuggers)
- 🔴 Empty states, error states, and 404/500 pages designed — no raw stack traces ever
- 🔴 Accessibility pass on public forms (keyboard, labels, contrast) — these face the general public
- 🟡 In-app help/docs for the builder; support email + shared inbox
- 🟡 5–8 industry onboarding templates (README §8 open question — decide before launch marketing)

## 8. Performance & Capacity

- 🔴 k6 load test: public form submit at 50 rps sustained, records list at Premium data volume (100k records) — p95 < 300ms API
- 🔴 Next.js: public pages (landing, forms) statically optimized/ISR; bundle analyzed; images optimized
- 🔴 Cold-start behavior on serverless measured; Mongo client reuse confirmed
- 🟡 CDN caching rules for public form assets

## 9. Launch Procedure (Day 0)

1. Freeze `develop`; cut `GRAFT-NN-release/v1.0.0` per AGENTS.md §4 (the `develop` → `main` promotion PR)
2. `npm run release:check` green in CI
3. Run migrations + indexes against Atlas (migrator user)
4. Deploy to production; run smoke Bruno suite against live URL (read-only + one canary tenant write)
5. Verify: sign-up flow manually, Stripe test purchase with a real card (then refund), public form submit from a phone on mobile data
6. Enable uptime alerts, unmute Sentry
7. Tag release, publish changelog
8. **Post-launch watch:** 48h heightened monitoring; error budget defined (rollback if error rate > 2% for 15 min)

## 10. Day-2 (first 30 days)

- 🟡 items above; first restore drill from live backups; review rate-limit tuning against real traffic; first pricing review vs actual usage distributions; capture onboarding funnel analytics (privacy-respecting) to fix drop-off steps.

---

## Sign-off

| Area | Owner | Signed |
|---|---|---|
| Infrastructure & DB | | ☐ |
| Security | | ☐ |
| Payments/Tiers | | ☐ |
| Legal | | ☐ |
| Product/QA | | ☐ |
| Final go/no-go | | ☐ |

*No single person signs more than two areas.*
