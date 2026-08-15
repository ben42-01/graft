# Graft

**A generic, plugin-driven Business Management System for local and medium-sized businesses.**

---

## TL;DR

Graft is a customizable Business Management System (BMS). Instead of forcing every business into the same rigid CRM/ERP mold, Graft gives each customer a **dynamic, composable workspace**: they enable plugins, build input forms, and shape their own data models — so a barber shop, a plumbing company, and a small logistics firm can all run on the same platform while having completely different experiences.

- **Frontend:** Next.js (App Router) + shadcn/ui — every UI component doubles as a configurable "Business Item" building block
- **Backend:** Node/Next API layer with a strong service architecture
- **Database:** MongoDB — schema-flexible documents to support data model abstraction across wildly different business types
- **Monetization:** Free, Premium, and Enterprise tiers
- **Killer feature:** Shareable **Customer Forms** — businesses create public forms (bookings, quotes, feedback, lead capture) and share them via link or social media as adverts

---

## 1. The Problem

Local and medium businesses are underserved:

- Off-the-shelf tools (CRMs, booking apps, invoicing apps) each solve *one* slice, forcing businesses to juggle 4–6 subscriptions.
- Enterprise suites are too expensive and too complex.
- Every business is different — a fixed data model never fits everyone.

## 2. The Graft Answer

Graft is **generic by design**. The platform itself makes almost no assumptions about what a "customer", "job", "order", or "appointment" is. Instead:

1. **Plugins** provide capability (Contacts, Invoicing, Scheduling, Inventory, Forms, Reports…).
2. **Entity Builder** lets users define their own data objects and fields.
3. **Form Builder** turns those entities into internal input forms *and* public-facing Customer Forms.
4. **Dashboard Composer** lets users arrange shadcn-based widgets into their own management UI.

The result: each tenant "grafts" together the exact system their business needs.

---

## 3. Onboarding Experience (First-Run Flow)

**Goal: from sign-up to a working, personalized BMS in under 10 minutes.**

1. **Landing page** — value proposition, tier comparison, live demo. CTA: *Sign Up* / *Login*.
2. **Sign up** — email + password or OAuth (Google/Microsoft). Email verification.
3. **Business profile wizard**
   - Business name, logo, industry (select or "Other"), size, region/currency/timezone.
4. **Template suggestion**
   - Based on industry, Graft suggests a starter bundle (e.g. "Trades & Services": Contacts + Jobs + Quotes + Scheduling).
   - User can accept, tweak, or start from a blank canvas.
5. **Plugin selection**
   - Toggle plugins on/off. Free tier limits apply (e.g. max 3 plugins).
6. **Entity & form setup**
   - Guided creation of their first entity (e.g. "Customer") and first input form, with sensible field defaults they can edit.
7. **Dashboard composition**
   - Drag-and-drop widgets (tables, KPI cards, calendars, charts) onto their home dashboard.
8. **First Customer Form**
   - Prompt: "Create a form your customers can fill in." Generates a public shareable link + social share buttons.
9. **Done screen** — checklist of what they set up, quick links, invite team members (Premium+).

Onboarding state is saved per step, so users can leave and resume.

---

## 4. Core Concepts & Architecture

### 4.1 Plugins

A plugin is a self-contained capability package:

```
plugin = {
  id, name, version,
  entities: [...],        // data models it introduces or extends
  forms: [...],           // default forms
  widgets: [...],         // dashboard components
  routes: [...],          // pages it adds to the tenant workspace
  permissions: [...],     // roles/scopes it defines
  tier: "free" | "premium" | "enterprise"
}
```

Initial plugin catalog (MVP candidates):

| Plugin | Description | Tier |
|---|---|---|
| Contacts | Customers, suppliers, leads | Free |
| Forms | Internal + public Customer Forms | Free |
| Scheduling | Calendar, appointments, bookings | Free (basic) |
| Invoicing | Quotes, invoices, payment status | Premium |
| Inventory | Stock, products, price lists | Premium |
| Reports | Charts, exports, KPIs | Premium |
| Automations | Triggers & actions (form submitted → email) | Premium |
| Team & Roles | Multi-user, permissions | Premium |
| API Access / Webhooks | Integrations | Enterprise |
| White-labeling & SSO | Custom domain, branding, SAML | Enterprise |

### 4.2 Entity Builder (Data Model Abstraction)

MongoDB is the right fit because tenant-defined schemas map naturally to documents.

Proposed core collections:

```
tenants          — business account, tier, settings, branding
users            — auth identities, tenant memberships, roles
plugins_enabled  — per-tenant plugin activation + config
entity_defs      — user-defined schemas (fields, types, validation, relations)
records          — the actual data rows, keyed by tenantId + entityDefId
forms            — form definitions (internal or public), bound to entity_defs
form_submissions — submissions from public Customer Forms
dashboards       — widget layouts per tenant/user
audit_log        — who did what, when (Premium+)
```

Key pattern: **`records` is a single polymorphic collection** — each document stores `tenantId`, `entityDefId`, and a `data` object validated at the API layer against the tenant's `entity_defs`. Compound indexes on `(tenantId, entityDefId)` plus selective indexes on promoted/searchable fields keep it fast.

### 4.3 shadcn/ui as Business Building Blocks

Every shadcn component is wrapped as a **Graft Widget** with a config schema:

- `Table` → Record List widget (bound to an entity, with filters/sorting)
- `Card` → KPI / summary widget
- `Form` (+ react-hook-form + zod) → Form renderer for entity fields
- `Calendar` → Scheduling widget
- `Chart` (recharts) → Report widget
- `Dialog`, `Sheet`, `Tabs` → layout primitives for detail views

Widgets are declared as JSON config, rendered by a **Widget Registry**, so dashboards are pure data — portable, versionable, and tier-gated.

### 4.4 Customer Forms (Public Sharing)

- Built in the Form Builder, bound to an entity (e.g. "Booking Request").
- Published to a public URL: `graft.app/f/{tenantSlug}/{formSlug}` (custom domains on Enterprise).
- Auto-generated **Open Graph card** (business logo, colors, headline) so the link looks like a proper advert when shared on social media.
- Submissions land in `form_submissions` and create/update `records`, triggering notifications or automations.
- Anti-abuse: rate limiting, CAPTCHA option, spam filtering.
- Free tier: limited submissions/month; Premium: higher limits + branding removal; Enterprise: unlimited + custom domain.

---

## 5. Tiers

| | Free | Premium | Enterprise |
|---|---|---|---|
| Plugins | 3 core | All standard | All + custom |
| Users | 1 | Up to 15 | Unlimited |
| Custom entities | 3 | 25 | Unlimited |
| Customer Forms | 2 forms, 100 subs/mo | 20 forms, 5k subs/mo | Unlimited |
| Automations | — | ✓ | ✓ Advanced |
| Branding | Graft badge | Remove badge | White-label + custom domain |
| Support | Community | Email | SLA + dedicated |
| API / Webhooks | — | Limited | Full |

---

## 6. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | SSR for public forms/SEO, RSC for dashboards |
| UI | shadcn/ui + Tailwind | Widget registry wraps components |
| Forms | react-hook-form + zod | Zod schemas generated from `entity_defs` |
| State | TanStack Query (+ Zustand where needed) | Server-state first |
| Auth | Auth.js (NextAuth) or Clerk | OAuth + credentials; SSO later |
| API | Next.js Route Handlers → service layer | Consider tRPC for internal type-safety |
| Database | MongoDB Atlas + Mongoose/native driver | Multi-tenant via `tenantId` on every doc |
| Payments | Stripe | Tier subscriptions + metered limits |
| File storage | S3-compatible (logos, attachments) | |
| Email | Resend / SES | Verification, notifications, automations |
| Hosting | Vercel (app) + Atlas | Enterprise: option for dedicated cluster |

### Multi-tenancy & Security Principles

- Every query is scoped by `tenantId` at the service layer — never trust the client.
- Role-based access control defined per plugin, enforced server-side.
- Tier limits enforced in middleware (plugin activation, record counts, submissions).
- Public forms are the only unauthenticated write surface — hardened accordingly.
- Audit logging, encrypted secrets, GDPR-friendly data export/delete per tenant.

---

## 7. MVP Scope (Phase 1)

1. Auth + tenant creation + onboarding wizard
2. Plugin framework with 3 plugins: **Contacts, Forms, Scheduling (basic)**
3. Entity Builder (create/edit entity defs, field types: text, number, date, select, checkbox, file)
4. Record CRUD via generated forms + Record List widget
5. Dashboard Composer (fixed grid, 4–5 widget types)
6. Public Customer Forms with shareable links + OG cards
7. Free tier limits + Stripe checkout for Premium

## Phase 2

Invoicing, Reports, Automations, Team & Roles, submission analytics, template marketplace.

## Phase 3 (Enterprise)

API/webhooks, SSO/SAML, white-labeling, custom domains, dedicated infrastructure, plugin SDK for third-party developers.

---

## 8. Open Questions

- **Plugin SDK:** internal-only plugins first, or design for third-party developers from day one?
- **tRPC vs REST:** internal type-safety vs. easier future public API.
- **Record validation:** enforce with MongoDB JSON Schema per collection, or purely at the API layer?
- **Onboarding templates:** how many industry templates at launch? (Suggest 5–8.)
- **Pricing:** exact price points per tier and regional pricing.
- **Name/branding:** "Graft" — check trademark availability and domain options.

---

*Graft — graft together the business system that fits you.*
