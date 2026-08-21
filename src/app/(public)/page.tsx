"use client";

/**
 * GRAFT-19 `/` — the public marketing root, replacing the former situation
 * where `/` sat inside `(app)` and immediately redirected an unauthenticated
 * visitor to `/login` (AC1). The authenticated home moved to `/home`
 * (`src/app/(app)/home/page.tsx`) so the two route groups don't both resolve
 * to `/` — see that file's doc comment and AC8.
 *
 * Tier limits/features render straight from `src/server/tiers.ts`'s
 * `TIER_LIMITS`/`TIER_FEATURES` (AC2) — a plain data import, not a new API,
 * and never duplicated as hardcoded numbers that could drift from the
 * server's source of truth. Only the price *copy* below is hand-written:
 * `docs/TIERS.md` §3 marks those figures "proposed, to validate", and the
 * human requester confirmed on 2026-08-19 to hardcode them as-is pending
 * that validation (€29/mo Premium incl. 5 seats / €290/yr, Enterprise "from
 * €299/mo") — see the issue's Context section.
 *
 * Checkout wiring (AC3-AC5): `POST /api/v1/billing/checkout`
 * (`src/server/services/billing.ts`) is owner-only and already enforces
 * that server-side — the `status !== "authenticated"` branch below and the
 * inline FORBIDDEN message are UX only, per docs/BACKEND.md's "never in the
 * client" entitlement principle; a non-owner or anonymous caller who somehow
 * reached the fetch would still get the real 403 back.
 *
 * ---
 * UI refinement (2026-08-21, ad-hoc — no issue). Three things changed and the
 * reasoning matters more than the markup:
 *
 * 1. **Branding.** The page carried none. It now opens with the concept-A
 *    lockup (`src/components/brand/graft-logo.tsx`, see BRAND.md) in a sticky
 *    header and closes on the mark in the footer.
 *
 * 2. **The cards were far too tall** because each one dumped *every* limit key
 *    and *every* feature flag inline. The full lists are still rendered — AC2
 *    reads `data-limit`/`data-feature` attributes and must keep finding all of
 *    them — but they now live inside a collapsed `<details>`, with only the
 *    three headline limits shown open. Collapsing rather than trimming is
 *    deliberate: trimming would have meant hand-picking which keys to render
 *    and reintroducing exactly the drift AC2 exists to prevent.
 *
 * 3. **Audience toggle** (Individual · Team & Enterprise), modelled on the
 *    Claude pricing page, replacing the dead "See pricing" hero button — it
 *    scrolled to content already on screen. Both panels stay *mounted* and the
 *    inactive one is hidden with a class, so the tier data attributes AC2
 *    asserts on are in the DOM on first paint regardless of which tab is up;
 *    only AC1's enterprise-card *visibility* check has to click the toggle
 *    first, and e2e/pricing.spec.ts was updated to do so.
 *
 * 4. **Billing period toggle** replaces the two stacked Subscribe buttons, so
 *    the Premium card has one CTA. It lives on the Premium card's header row
 *    (only that tier is priced) rather than above the grid, beside the tier
 *    name rather than above the price so both cards' price rows still align. The button keeps the per-period testid
 *    (`subscribe-premium-monthly` / `-annual`) of whichever period is
 *    selected; monthly is the default, which is what AC3/AC4/AC5 click.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { GraftLockup, GraftMark } from "@/components/brand/graft-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FEATURE_LABEL, LIMIT_LABEL, TIER_LABEL, formatLimit } from "@/lib/tier-copy";
import { useMe } from "@/lib/session";
import { FEATURES, LIMIT_KEYS, TIER_FEATURES, TIER_LIMITS, type Tier } from "@/server/tiers";

type CheckoutPlan = "monthly" | "annual";

type CheckoutResult = { ok: true; url: string } | { ok: false; message: string };

/** Where Enterprise prospects land. Confirmed by the requester 2026-08-21. */
const SALES_EMAIL = "team.agora.hub@gmail.com";

async function startCheckout(plan: CheckoutPlan): Promise<CheckoutResult> {
  try {
    const response = await fetch("/api/v1/billing/checkout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const body = (await response.json().catch(() => null)) as
      { data: { url: string } } | { error: { message: string } } | null;
    if (!response.ok || !body || "error" in body) {
      const message = body && "error" in body ? body.error.message : "Something went wrong.";
      return { ok: false, message };
    }
    return { ok: true, url: body.data.url };
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
}

const TIER_BLURB: Record<Tier, string> = {
  free: "Try the whole product on one workspace, for as long as you like.",
  premium: "For a working team that runs the business on Graft every day.",
  enterprise: "For organisations with their own identity, domain and integrations.",
};

/** Pricing copy — hand-written, see the file doc comment above. */
const PRICE_COPY: Record<
  Tier,
  Record<CheckoutPlan, { amount: string; period: string; note: string }>
> = {
  free: {
    monthly: { amount: "€0", period: "forever", note: "No card required" },
    annual: { amount: "€0", period: "forever", note: "No card required" },
  },
  premium: {
    monthly: {
      amount: "€29",
      period: "/ month per tenant",
      note: "Includes 5 seats",
    },
    annual: {
      amount: "€290",
      period: "/ year per tenant",
      note: "2 months free · includes 5 seats",
    },
  },
  enterprise: {
    monthly: { amount: "From €299", period: "/ month", note: "Custom terms" },
    annual: { amount: "Custom", period: "annual agreement", note: "Custom terms" },
  },
};

/** The limits AC2 requires at minimum, in display order; the rest of
 * `TIER_LIMITS`'s keys follow after. */
const HEADLINE_LIMIT_KEYS = ["seats", "activeForms", "submissionsPerMonth"] as const;

/** Headline-bullet wording, where the label follows the number and so has to
 * agree with it ("1 seat", not "1 seats"). `LIMIT_LABEL` (@/lib/tier-copy) is
 * the standalone column heading and stays plural. */
const HEADLINE_NOUN: Record<(typeof HEADLINE_LIMIT_KEYS)[number], [string, string]> = {
  seats: ["seat", "seats"],
  activeForms: ["active form", "active forms"],
  submissionsPerMonth: ["submission / month", "submissions / month"],
};
const OTHER_LIMIT_KEYS = LIMIT_KEYS.filter(
  (k) => !(HEADLINE_LIMIT_KEYS as readonly string[]).includes(k),
);

/** What Enterprise adds over Premium — derived, never listed by hand, so the
 * marketing claim can't drift from `TIER_FEATURES` (the same principle AC2
 * enforces for the limits). */
const ENTERPRISE_EXTRAS = FEATURES.filter(
  (f) => TIER_FEATURES.enterprise[f] && !TIER_FEATURES.premium[f],
);

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <Check
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-graft-green dark:text-graft-green-light"
      />
      <span>{children}</span>
    </li>
  );
}

/** The full limit + feature matrix for one tier, collapsed by default.
 * Rendered for every tier so AC2's `data-limit` / `data-feature` reads
 * resolve without opening anything — see the file doc comment, point 2. */
function TierDetails({ tier }: { tier: Tier }) {
  const limits = TIER_LIMITS[tier];
  const features = FEATURES.filter((f) => TIER_FEATURES[tier][f]);

  return (
    <details className="group border-t pt-4">
      <summary className="cursor-pointer list-none text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span className="group-open:hidden">All limits and features →</span>
        <span className="hidden group-open:inline">Hide details ←</span>
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <ul className="flex flex-col gap-1.5 text-sm" data-testid={`tier-${tier}-limits`}>
          {[...HEADLINE_LIMIT_KEYS, ...OTHER_LIMIT_KEYS].map((key) => (
            <li
              key={key}
              data-limit={key}
              data-value={String(limits[key])}
              className="flex justify-between gap-4"
            >
              <span className="text-muted-foreground">{LIMIT_LABEL[key] ?? key}</span>
              <span className="font-medium tabular-nums">{formatLimit(key, limits[key])}</span>
            </li>
          ))}
        </ul>
        {features.length > 0 ? (
          <ul
            className="flex flex-col gap-1.5 text-sm text-muted-foreground"
            data-testid={`tier-${tier}-features`}
          >
            {features.map((f) => (
              <li key={f} data-feature={f} className="flex items-start gap-2.5">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 opacity-60" />
                {FEATURE_LABEL[f]}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

function TierCard({
  tier,
  plan,
  featured,
  action,
  children,
}: {
  tier: Tier;
  plan: CheckoutPlan;
  featured?: boolean;
  /** Optional control on the header row, opposite the tier name. Only Premium
   * uses it (the billing-period switch) — it sits beside the label rather than
   * above the price so the two cards' price rows still line up. */
  action?: React.ReactNode;
  /** The tier's call to action — each tier's differs enough that threading
   * every variant through props would be worse than passing the button. */
  children: React.ReactNode;
}) {
  const limits = TIER_LIMITS[tier];
  const price = PRICE_COPY[tier][plan];

  return (
    <Card
      data-testid={`tier-${tier}`}
      className={cn(
        "relative flex-1 gap-0 py-7",
        featured && "border-graft-green/40 shadow-md ring-1 ring-graft-green/20",
      )}
    >
      {featured ? (
        <span className="absolute -top-3 left-7 rounded-full bg-graft-green px-3 py-1 text-xs font-semibold text-white">
          Most popular
        </span>
      ) : null}

      <CardHeader className="gap-3">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
            {TIER_LABEL[tier]}
          </h3>
          {action}
        </div>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-4xl font-semibold tracking-tight"
            data-testid={`price-${tier}-${plan}`}
          >
            {price.amount}
          </span>
          <span className="text-sm text-muted-foreground">{price.period}</span>
        </p>
        <p className="text-sm text-muted-foreground">{price.note}</p>
      </CardHeader>

      <CardFooter className="mt-6 flex-col gap-2">{children}</CardFooter>

      <CardContent className="mt-7 flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">{TIER_BLURB[tier]}</p>
        <ul className="flex flex-col gap-2.5 text-sm">
          {HEADLINE_LIMIT_KEYS.map((key) => {
            const [singular, plural] = HEADLINE_NOUN[key];
            return (
              <CheckItem key={key}>
                <span className="font-medium">{formatLimit(key, limits[key])}</span>{" "}
                <span className="text-muted-foreground">
                  {limits[key] === 1 ? singular : plural}
                </span>
              </CheckItem>
            );
          })}
        </ul>
        <TierDetails tier={tier} />
      </CardContent>
    </Card>
  );
}

/** A two-option pill switch. Used for both the audience and the billing
 * period, so the two read as one control family. */
function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  compact,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string; testId: string }[];
  /** Sized to sit on a card header row rather than stand alone on the page. */
  compact?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("inline-flex rounded-full border bg-muted/50", compact ? "p-0.5" : "p-1")}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full font-medium transition-colors",
              compact ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-sm",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

type Audience = "individual" | "team";

export default function PricingPage() {
  const router = useRouter();
  const { status } = useMe();
  const [submittingPlan, setSubmittingPlan] = useState<CheckoutPlan | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("individual");
  const [plan, setPlan] = useState<CheckoutPlan>("monthly");

  const handleSubscribe = async (selected: CheckoutPlan) => {
    // AC5 — checkout requires a tenant to attach to; an anonymous visitor
    // goes to sign up first rather than hitting the checkout API.
    if (status !== "authenticated") {
      router.push("/signup");
      return;
    }

    setCheckoutError(null);
    setSubmittingPlan(selected);
    const result = await startCheckout(selected);
    setSubmittingPlan(null);

    if (!result.ok) {
      // AC4 — the API's owner-only 403 (FORBIDDEN) surfaced, not swallowed.
      setCheckoutError(result.message);
      return;
    }
    // AC3 — full navigation to the Stripe-hosted checkout URL.
    window.location.href = result.url;
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          {/* `next/link` here rather than the plain `<a>` the rest of this
           * file uses: @next/next/no-html-link-for-pages only rejects a raw
           * anchor to `/`. */}
          <Link href="/" aria-label="Graft home" className="flex items-center">
            <GraftLockup className="h-7" />
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href="/login">Log in</a>
            </Button>
            <Button asChild size="sm">
              <a href="/signup">Get started</a>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 pt-20 pb-14 text-center sm:pt-28 sm:pb-20">
          <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-graft-green" aria-hidden />
            Entities, forms, dashboards and automations
          </span>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Run your business on Graft
          </h1>
          <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
            Graft together the business system that fits you — start free, grow into Premium or
            Enterprise when you need more.
          </p>
          <Button asChild size="lg" data-testid="hero-signup">
            <a href="/signup">Get started free</a>
          </Button>
          <p className="text-sm text-muted-foreground">
            Free forever on one workspace. No card required.
          </p>
        </section>

        <section id="pricing" className="mx-auto max-w-5xl scroll-mt-20 px-6 pb-24">
          <div className="flex flex-col items-center gap-6 pb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight">Pricing</h2>
            <Segmented
              label="Who is this for"
              value={audience}
              onChange={setAudience}
              options={[
                { value: "individual", label: "Individual", testId: "audience-individual" },
                { value: "team", label: "Team & Enterprise", testId: "audience-team" },
              ]}
            />
          </div>

          {checkoutError ? (
            <p
              role="alert"
              data-testid="checkout-error"
              className="pb-6 text-center text-sm text-destructive"
            >
              {checkoutError}
            </p>
          ) : null}

          {/* Both panels stay mounted — see the file doc comment, point 3. */}
          <div
            role="tabpanel"
            aria-label="Individual"
            className={cn(
              "flex flex-col items-center gap-8",
              audience !== "individual" && "hidden",
            )}
          >
            <div className="flex w-full flex-col gap-6 sm:flex-row sm:items-start">
              <TierCard tier="free" plan={plan}>
                <Button asChild variant="outline" className="w-full" data-testid="signup-free">
                  <a href="/signup">Get started free</a>
                </Button>
              </TierCard>
              <TierCard
                tier="premium"
                plan={plan}
                featured
                action={
                  <Segmented
                    compact
                    label="Billing period"
                    value={plan}
                    onChange={setPlan}
                    options={[
                      { value: "monthly", label: "Monthly", testId: "billing-monthly" },
                      { value: "annual", label: "Annual", testId: "billing-annual" },
                    ]}
                  />
                }
              >
                <Button
                  type="button"
                  className="w-full"
                  data-testid={`subscribe-premium-${plan}`}
                  disabled={submittingPlan !== null}
                  onClick={() => handleSubscribe(plan)}
                >
                  {submittingPlan === plan
                    ? "Starting checkout…"
                    : plan === "monthly"
                      ? "Subscribe monthly"
                      : "Subscribe annually"}
                </Button>
              </TierCard>
            </div>
          </div>

          <div
            role="tabpanel"
            aria-label="Team & Enterprise"
            className={cn("flex justify-center", audience !== "team" && "hidden")}
          >
            <Card data-testid="tier-enterprise" className="w-full max-w-2xl py-8">
              <CardHeader className="gap-3">
                <h3 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
                  {TIER_LABEL.enterprise}
                </h3>
                <p className="text-2xl font-semibold tracking-tight text-balance">
                  Built for teams that outgrow the box
                </p>
                <p className="text-sm text-muted-foreground">
                  {TIER_BLURB.enterprise} Priced per organisation —{" "}
                  <span
                    className="font-medium text-foreground"
                    data-testid="price-enterprise-monthly"
                  >
                    {PRICE_COPY.enterprise.monthly.amount}
                  </span>{" "}
                  {PRICE_COPY.enterprise.monthly.period}.
                </p>
              </CardHeader>

              <CardContent className="mt-7 flex flex-col gap-7">
                <ul className="grid gap-2.5 text-sm sm:grid-cols-2">
                  <CheckItem>
                    <span className="font-medium">Unlimited</span>{" "}
                    <span className="text-muted-foreground">
                      seats, forms, records and dashboards
                    </span>
                  </CheckItem>
                  {ENTERPRISE_EXTRAS.map((f) => (
                    <CheckItem key={f}>{FEATURE_LABEL[f]}</CheckItem>
                  ))}
                </ul>

                <div className="rounded-lg border bg-muted/40 p-6">
                  <h4 className="text-sm font-semibold">Talk to us</h4>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Tell us what your organisation needs and we&rsquo;ll scope it with you —
                    limits, integrations, rollout and terms.
                  </p>
                  <p className="mt-4 text-sm">
                    <a
                      href={`mailto:${SALES_EMAIL}?subject=Enterprise%20plan`}
                      className="font-medium underline underline-offset-4"
                    >
                      {SALES_EMAIL}
                    </a>
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Typical reply within one business day.
                  </p>
                  <Button asChild className="mt-5" data-testid="contact-enterprise">
                    <a href={`mailto:${SALES_EMAIL}?subject=Enterprise%20plan`}>
                      Contact sales
                    </a>
                  </Button>
                </div>

                <TierDetails tier="enterprise" />
              </CardContent>
            </Card>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2.5">
            <GraftMark className="h-5 w-5" />
            <span>Graft together the business system that fits you.</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/privacy"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Privacy
            </Link>
            <a
              href={`mailto:${SALES_EMAIL}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {SALES_EMAIL}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
