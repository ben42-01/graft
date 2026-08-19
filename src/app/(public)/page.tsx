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
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useMe } from "@/lib/session";
import {
  FEATURES,
  LIMIT_KEYS,
  TIER_FEATURES,
  TIER_LIMITS,
  TIERS,
  type Tier,
} from "@/server/tiers";

type CheckoutPlan = "monthly" | "annual";

type CheckoutResult = { ok: true; url: string } | { ok: false; message: string };

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

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  premium: "Premium",
  enterprise: "Enterprise",
};

/** Pricing copy — hand-written, see the file doc comment above. */
const PRICE_COPY: Record<Tier, { monthly: string; annual: string }> = {
  free: { monthly: "€0", annual: "€0" },
  premium: {
    monthly: "€29 / mo per tenant (incl. 5 seats)",
    annual: "€290 / yr (2 months free)",
  },
  enterprise: { monthly: "From €299 / mo", annual: "Custom" },
};

const LIMIT_LABEL: Record<string, string> = {
  seats: "Seats",
  activeForms: "Active forms",
  submissionsPerMonth: "Submissions / month",
  entities: "Custom entities",
  records: "Records",
  storageMb: "Storage",
  dashboards: "Dashboards",
  plugins: "Plugins enabled",
  internalForms: "Internal forms",
};

/** The limits AC2 requires at minimum, in display order; the rest of
 * `TIER_LIMITS`'s keys follow after. */
const HEADLINE_LIMIT_KEYS = ["seats", "activeForms", "submissionsPerMonth"] as const;
const OTHER_LIMIT_KEYS = LIMIT_KEYS.filter(
  (k) => !(HEADLINE_LIMIT_KEYS as readonly string[]).includes(k),
);

function formatLimit(key: string, value: number | null): string {
  if (value === null) return "Unlimited";
  if (key === "storageMb") return value >= 1024 ? `${value / 1024} GB` : `${value} MB`;
  return value.toLocaleString();
}

const FEATURE_LABEL: Record<(typeof FEATURES)[number], string> = {
  csv_import: "Batch CSV import",
  external_connectors: "External tenant connectors",
  inbound_webhooks: "Inbound webhooks",
  outbound_webhooks: "Outbound webhooks",
  public_api: "Public REST API",
  automations: "Automations",
  custom_roles: "Custom roles",
  audit_log: "Audit log",
  form_file_uploads: "Form file uploads",
  form_conditional_logic: "Conditional form logic",
  form_analytics: "Form analytics",
  remove_branding: "Remove Graft branding",
  custom_form_domain: "Custom form domain",
  invoicing: "Invoicing plugin",
  reports: "Reports plugin",
  sso: "SSO (SAML / OIDC)",
  white_label: "White-labeling",
  custom_plugins: "Custom plugin development",
};

function TierCard({
  tier,
  onSubscribe,
  submittingPlan,
}: {
  tier: Tier;
  onSubscribe: (plan: CheckoutPlan) => void;
  submittingPlan: CheckoutPlan | null;
}) {
  const limits = TIER_LIMITS[tier];
  const features = FEATURES.filter((f) => TIER_FEATURES[tier][f]);

  return (
    <Card className="flex-1" data-testid={`tier-${tier}`}>
      <CardHeader>
        <CardTitle className="text-lg">{TIER_LABEL[tier]}</CardTitle>
        <p
          className="text-2xl font-semibold tracking-tight"
          data-testid={`price-${tier}-monthly`}
        >
          {PRICE_COPY[tier].monthly}
        </p>
        <p className="text-sm text-muted-foreground" data-testid={`price-${tier}-annual`}>
          {PRICE_COPY[tier].annual}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1 text-sm" data-testid={`tier-${tier}-limits`}>
          {[...HEADLINE_LIMIT_KEYS, ...OTHER_LIMIT_KEYS].map((key) => (
            <li key={key} data-limit={key} data-value={String(limits[key])}>
              <span className="text-muted-foreground">{LIMIT_LABEL[key] ?? key}:</span>{" "}
              {formatLimit(key, limits[key])}
            </li>
          ))}
        </ul>
        {features.length > 0 ? (
          <ul
            className="flex flex-col gap-1 text-sm text-muted-foreground"
            data-testid={`tier-${tier}-features`}
          >
            {features.map((f) => (
              <li key={f} data-feature={f}>
                {FEATURE_LABEL[f]}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        {tier === "enterprise" ? (
          <Button asChild className="w-full" data-testid="contact-enterprise">
            <a href="mailto:sales@graft.app?subject=Enterprise%20plan">Contact us</a>
          </Button>
        ) : tier === "premium" ? (
          <>
            <Button
              type="button"
              className="w-full"
              data-testid="subscribe-premium-monthly"
              disabled={submittingPlan !== null}
              onClick={() => onSubscribe("monthly")}
            >
              {submittingPlan === "monthly" ? "Starting checkout…" : "Subscribe monthly"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              data-testid="subscribe-premium-annual"
              disabled={submittingPlan !== null}
              onClick={() => onSubscribe("annual")}
            >
              {submittingPlan === "annual" ? "Starting checkout…" : "Subscribe annually"}
            </Button>
          </>
        ) : (
          <Button asChild variant="outline" className="w-full" data-testid="signup-free">
            <a href="/signup">Get started free</a>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

export default function PricingPage() {
  const router = useRouter();
  const { status } = useMe();
  const [submittingPlan, setSubmittingPlan] = useState<CheckoutPlan | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const handleSubscribe = async (plan: CheckoutPlan) => {
    // AC5 — checkout requires a tenant to attach to; an anonymous visitor
    // goes to sign up first rather than hitting the checkout API.
    if (status !== "authenticated") {
      router.push("/signup");
      return;
    }

    setCheckoutError(null);
    setSubmittingPlan(plan);
    const result = await startCheckout(plan);
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
    <div className="mx-auto flex max-w-5xl flex-col gap-16 px-4 py-16">
      <header className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Run your business on Graft</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Entities, forms, dashboards and automations for service businesses — start free, grow
          into Premium or Enterprise when you need more.
        </p>
        <div className="flex gap-3">
          <Button asChild size="lg" data-testid="hero-signup">
            <a href="/signup">Get started free</a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="#pricing">See pricing</a>
          </Button>
        </div>
      </header>

      <section id="pricing" className="flex flex-col gap-6">
        <h2 className="text-center text-2xl font-semibold tracking-tight">Pricing</h2>

        {checkoutError ? (
          <p
            role="alert"
            data-testid="checkout-error"
            className="mx-auto text-sm text-destructive"
          >
            {checkoutError}
          </p>
        ) : null}

        <div className="flex flex-col gap-6 sm:flex-row">
          {TIERS.map((tier) => (
            <TierCard
              key={tier}
              tier={tier}
              onSubscribe={handleSubscribe}
              submittingPlan={submittingPlan}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
