"use client";

/**
 * Account & plan (2026-08-21 UI refinement).
 *
 * The gap this closes: every tier gate in the authenticated app — the Chart
 * widget, "Add entity", the dashboard quota message — told a Free user to
 * "upgrade to Premium", but the only checkout button in the product lived on
 * the public landing page (`src/app/(public)/page.tsx`). Signed-in users had
 * no route to act on the prompt. This page is that route, and it is what the
 * gates now link to.
 *
 * It reuses the exact same call the landing page makes —
 * `POST /api/v1/billing/checkout` then a full navigation to the Stripe-hosted
 * URL — rather than inventing a second upgrade path; the tier transition
 * still happens only when Stripe calls the webhook (GRAFT-15).
 *
 * Limits render from `TIER_LIMITS` (pure data, the same import the pricing
 * page uses), overlaid with `me.tenant.limits` where the tenant carries its
 * own overrides — an Enterprise deal can raise a limit per tenant without a
 * code change, and this page must show what the tenant actually has.
 */
import { useState } from "react";
import Link from "next/link";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { FEATURE_LABEL, LIMIT_LABEL, TIER_LABEL, formatLimit } from "@/lib/tier-copy";
import {
  FEATURES,
  LIMIT_KEYS,
  TIER_FEATURES,
  TIER_LIMITS,
  type Tier,
  type TierLimits,
} from "@/server/tiers";

type CheckoutPlan = "monthly" | "annual";

/** Where Enterprise prospects land — same address the landing page uses. */
const SALES_EMAIL = "team.agora.hub@gmail.com";

const PRICE_COPY: Record<CheckoutPlan, { amount: string; period: string; note: string }> = {
  monthly: { amount: "€29", period: "/ month per workspace", note: "Includes 5 seats" },
  annual: { amount: "€290", period: "/ year per workspace", note: "2 months free" },
};

/** A tier's published limits, overridden by whatever `/me` reports for this
 * tenant — per-tenant overrides are the point of materialising them. */
function effectiveLimits(tier: Tier, tenantLimits: Record<string, unknown>): TierLimits {
  const base = { ...TIER_LIMITS[tier] };
  for (const key of LIMIT_KEYS) {
    const override = tenantLimits[key];
    if (override === null || typeof override === "number") base[key] = override;
  }
  return base;
}

const isTier = (value: string): value is Tier => value in TIER_LIMITS;

async function startCheckout(
  plan: CheckoutPlan,
): Promise<{ url: string } | { message: string }> {
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
      return {
        message: body && "error" in body ? body.error.message : "Something went wrong.",
      };
    }
    return { url: body.data.url };
  } catch {
    return { message: "Network error. Try again." };
  }
}

export default function AccountPage() {
  const { me } = useMe();
  const [plan, setPlan] = useState<CheckoutPlan>("monthly");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me) return <LoadingState label="Loading your account…" />;

  const tier: Tier = isTier(me.tenant.tier) ? me.tenant.tier : "free";
  const limits = effectiveLimits(tier, me.tenant.limits);
  const features = FEATURES.filter((feature) => TIER_FEATURES[tier][feature]);
  /** What Premium adds over the current tier — derived from the matrix, never
   * listed by hand, so the in-app pitch can't drift from what checkout buys. */
  const premiumOnly = FEATURES.filter(
    (feature) => TIER_FEATURES.premium[feature] && !TIER_FEATURES[tier][feature],
  );

  async function upgrade() {
    setSubmitting(true);
    setError(null);
    const result = await startCheckout(plan);
    if ("url" in result) {
      // Full navigation — Stripe Checkout is hosted off-origin.
      window.location.assign(result.url);
      return;
    }
    setError(result.message);
    setSubmitting(false);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {me.user.email} · {me.tenant.name}
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Current plan</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              What this workspace can do today.
            </p>
          </div>
          <span
            data-testid="current-tier"
            className="rounded-full border border-graft-green/40 bg-graft-green/10 px-3 py-1 text-sm font-medium text-graft-green dark:text-graft-green-light"
          >
            {TIER_LABEL[tier]}
          </span>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Limits
            </h2>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {LIMIT_KEYS.map((key) => (
                <li key={key} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{LIMIT_LABEL[key]}</span>
                  <span className="tabular-nums">{formatLimit(key, limits[key])}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Included
            </h2>
            {features.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <CheckIcon className="size-3.5 text-graft-green" aria-hidden />
                    {FEATURE_LABEL[feature]}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                Core CRUD, forms and dashboards — every paid feature below is an upgrade away.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {tier === "free" ? (
        <Card className="border-graft-green/30 ring-1 ring-graft-green/10">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Upgrade to Premium</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Unlocks{" "}
                {premiumOnly
                  .slice(0, 4)
                  .map((f) => FEATURE_LABEL[f])
                  .join(", ")}
                {premiumOnly.length > 4 ? ` and ${premiumOnly.length - 4} more` : ""}, plus far
                higher limits.
              </p>
            </div>
            <div
              role="group"
              aria-label="Billing period"
              className="inline-flex rounded-md border p-0.5"
            >
              {(["monthly", "annual"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={plan === option}
                  onClick={() => setPlan(option)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-xs font-medium capitalize transition-colors",
                    plan === option
                      ? "bg-graft-green text-white"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <p className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">
                {PRICE_COPY[plan].amount}
              </span>
              <span className="text-sm text-muted-foreground">{PRICE_COPY[plan].period}</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{PRICE_COPY[plan].note}</p>
            {error ? (
              <p
                role="alert"
                data-testid="checkout-error"
                className="mt-3 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-3">
            <Button
              type="button"
              data-testid={`upgrade-premium-${plan}`}
              disabled={submitting}
              onClick={() => void upgrade()}
            >
              {submitting ? "Starting checkout…" : "Upgrade to Premium"}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/#pricing">
                Compare plans <ExternalLinkIcon className="size-3.5" />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {tier !== "enterprise" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Need Enterprise?</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              SSO, custom domain, audit log and unlimited workspaces — arranged with us
              directly.
            </p>
          </CardHeader>
          <CardFooter>
            <Button asChild variant="outline" size="sm">
              <a href={`mailto:${SALES_EMAIL}?subject=Graft Enterprise`}>Talk to us</a>
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
