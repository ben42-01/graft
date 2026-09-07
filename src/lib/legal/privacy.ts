/**
 * The Graft privacy statement, as structured data.
 *
 * Written as data rather than JSX for two reasons: the same text has to
 * render in-app (`/account/privacy`), render publicly for people who meet
 * Graft only through a customer's public form (`/privacy`), and serialise to
 * a Markdown file the reader can download — three surfaces, one source. And
 * a versioned, dated statement is a legal artefact: `VERSION` /
 * `EFFECTIVE_DATE` below are what a reader cites, so they must change
 * deliberately, in one place, when the text does.
 *
 * Every factual claim here is checked against the codebase as of 2026-08-21:
 *   - argon2id password hashing — src/server/auth/passwords.ts
 *   - `graft_access` / `graft_refresh`, the only cookies set —
 *     src/server/auth/cookies.ts
 *   - Stripe as the sole payment processor — src/server/services/billing.ts
 *   - MongoDB for storage, Redis for rate-limit counters — src/env.ts
 *   - no analytics, tracking or advertising SDK anywhere in package.json
 * If any of those change, this text is part of the change.
 *
 * ─── Before production launch ────────────────────────────────────────────
 * `COMPANY` below carries the details only the operator can supply (the
 * registered entity, its address, the governing jurisdiction). They are
 * written to read correctly as-is, but they are placeholders, and this
 * statement should have a lawyer's eye on it before it is relied on.
 */

/** The one contact channel for privacy questions and rights requests. */
export const PRIVACY_CONTACT_EMAIL = "team.agora.hub@gmail.com";

/** @todo Confirm before production launch — see the file header. */
export const COMPANY = {
  /** Registered legal entity operating the service. */
  legalName: "Graft",
  /** Postal address, once the entity is registered. */
  address: null as string | null,
  /** Governing law for the statement's disputes section. */
  jurisdiction: "the European Union",
} as const;

export const VERSION = "1.0";
export const EFFECTIVE_DATE = "2026-08-21";

/** A paragraph, or a bullet list. */
export type PrivacyBlock = { kind: "p"; text: string } | { kind: "ul"; items: string[] };
export type PrivacySection = { id: string; heading: string; blocks: PrivacyBlock[] };

const p = (text: string): PrivacyBlock => ({ kind: "p", text });
const ul = (items: string[]): PrivacyBlock => ({ kind: "ul", items });

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  {
    id: "who-we-are",
    heading: "Who we are",
    blocks: [
      p(
        `Graft is a business management system operated by ${COMPANY.legalName}. This statement explains what personal data the service handles, why, and what you can do about it. Questions and requests go to ${PRIVACY_CONTACT_EMAIL}.`,
      ),
      p(
        "Graft is used in two ways, and your relationship with us depends on which one applies to you. If you hold a Graft account, we handle your data as described below. If you reached Graft only by filling in a form published by one of our customers, that customer decides what is collected and why — they are the data controller, and Graft processes it on their instructions. Ask them first; we will help them answer you.",
      ),
    ],
  },
  {
    id: "what-we-collect",
    heading: "What we collect",
    blocks: [
      p("Account and workspace data you give us:"),
      ul([
        "Your email address, and your name if you provide one.",
        "Your password, stored only as an argon2id hash — we cannot read it, and we never store or log the password itself.",
        "The workspace name, business profile answers from onboarding, and your role in each workspace you belong to.",
        "Everything you build in the product: entities and their fields, the records stored against them, forms, dashboards and plugin settings. We treat this as yours; we do not mine it, sell it, or use it to train anything.",
      ]),
      p("Billing data, if you subscribe:"),
      ul([
        "Your plan, billing period and subscription status.",
        "A Stripe customer identifier. Card numbers are handled by Stripe and never reach our servers or logs.",
      ]),
      p("Technical data the service produces by running:"),
      ul([
        "Server request logs, each with a request identifier, the route, the response status and how long it took. Credentials and tokens are redacted from these.",
        "Short-lived rate-limit counters in Redis, keyed by IP address, email address or user id, kept for minutes at a time to stop brute-force and abuse.",
        "Two cookies, described under Cookies below.",
      ]),
      p(
        "We do not run analytics, advertising, session-replay or fingerprinting software of any kind. There are no third-party trackers on any Graft page.",
      ),
    ],
  },
  {
    id: "why",
    heading: "Why we use it, and on what basis",
    blocks: [
      ul([
        "To provide the service you signed up for — creating your account, keeping you signed in, storing and showing your workspace data. Basis: performance of our contract with you.",
        "To take payment and meet accounting obligations. Basis: performance of the contract, and legal obligation for the records we must keep.",
        "To keep the service secure and available — rate limiting, abuse prevention, debugging failures. Basis: our legitimate interest in a service that stays up and is not abused.",
        "To send transactional messages such as email verification. Basis: performance of the contract. We do not send marketing email from the product.",
      ]),
    ],
  },
  {
    id: "cookies",
    heading: "Cookies",
    blocks: [
      p(
        "Graft sets two cookies, both strictly necessary to keep you signed in. There are no analytics or advertising cookies, which is why the product shows no cookie banner.",
      ),
      ul([
        "graft_access — your short-lived signed session token, sent with each request so the server knows who you are.",
        "graft_refresh — a longer-lived token, restricted to the refresh endpoint, used to renew the session without asking you to sign in again.",
      ]),
      p("Signing out clears both. Blocking them makes the product unusable."),
    ],
  },
  {
    id: "sharing",
    heading: "Who else sees it",
    blocks: [
      p(
        "We do not sell personal data and we do not share it for advertising. We use a small number of processors to run the service:",
      ),
      ul([
        "Stripe — payment processing and subscription billing, for subscribers only.",
        "Our hosting and database infrastructure, which stores the data at rest.",
      ]),
      p(
        "Beyond that, we disclose data only where the law requires it, and we will tell you when we are permitted to.",
      ),
      p(
        "Inside a workspace, your data is visible to the other members of that workspace according to their roles. Data is isolated per workspace: no query in the product can read another tenant's data.",
      ),
    ],
  },
  {
    id: "retention",
    heading: "How long we keep it",
    blocks: [
      ul([
        "Account and workspace data: for as long as your account exists. Ask us to delete it and we will, subject to the records below.",
        "Billing records: for as long as tax and accounting law requires us to keep them, typically several years, even after an account closes.",
        "Request logs: a short operational window, then discarded.",
        "Rate-limit counters: minutes.",
      ]),
    ],
  },
  {
    id: "your-rights",
    heading: "Your rights",
    blocks: [
      p(
        "You can ask us to give you a copy of your data, correct it, delete it, restrict or object to how we use it, or hand it to another provider. The Privacy page inside your account has a one-click export of your workspace data as a JSON file, so you do not have to ask us for the common case.",
      ),
      p(
        `Email ${PRIVACY_CONTACT_EMAIL} for anything else. We answer within 30 days. If you are unhappy with our answer, you can complain to your local data protection authority.`,
      ),
    ],
  },
  {
    id: "security",
    heading: "How we protect it",
    blocks: [
      ul([
        "Passwords are hashed with argon2id and are never recoverable, by us or by anyone who obtains the database.",
        "Sessions use asymmetrically signed (RS256) tokens with short lifetimes and rotating keys.",
        "Every data access is scoped to one workspace at the query layer, not merely filtered in the interface.",
        "Traffic is served over TLS.",
      ]),
      p(
        `No system is perfect. If we ever suffer a breach affecting your data, we will tell you and the relevant authority as the law requires. If you believe you have found a vulnerability, please report it to ${PRIVACY_CONTACT_EMAIL} before disclosing it publicly.`,
      ),
    ],
  },
  {
    id: "transfers",
    heading: "Where your data lives",
    blocks: [
      p(
        `Graft stores data on infrastructure in ${COMPANY.jurisdiction}. Where a processor such as Stripe transfers data outside it, that transfer relies on the safeguards published by that processor, such as the European Commission's standard contractual clauses.`,
      ),
    ],
  },
  {
    id: "changes",
    heading: "Changes to this statement",
    blocks: [
      p(
        `This is version ${VERSION}, effective ${EFFECTIVE_DATE}. When we change it materially we will raise the version, change the date, and tell account holders in the product before the change takes effect. Every version is downloadable from this page so you can keep the one you agreed to.`,
      ),
    ],
  },
];

/** The statement as a Markdown document — what the download button saves. */
export function privacyMarkdown(): string {
  const lines: string[] = [
    "# Graft — Privacy Statement",
    "",
    `Version ${VERSION} · Effective ${EFFECTIVE_DATE}`,
    "",
    `Operator: ${COMPANY.legalName}${COMPANY.address ? ` · ${COMPANY.address}` : ""}`,
    `Contact: ${PRIVACY_CONTACT_EMAIL}`,
    "",
  ];

  for (const section of PRIVACY_SECTIONS) {
    lines.push(`## ${section.heading}`, "");
    for (const block of section.blocks) {
      if (block.kind === "p") lines.push(block.text, "");
      else lines.push(...block.items.map((item) => `- ${item}`), "");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
