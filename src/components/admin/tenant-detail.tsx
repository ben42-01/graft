"use client";

/**
 * The `/admin/tenants/[tenantId]` detail screen (GRAFT-27.3 AC7, AC8), read
 * from `GET /api/v1/admin/tenants/:tenantId`
 * (src/server/services/admin-tenants.ts `TenantDetail`).
 *
 * ## The nested `limits` shape, deliberately not flattened
 *
 * The GRAFT-27.2 review settled a naming collision the hard way: `data.limits`
 * is the *whole* resolved entitlement object (`Entitlements` —
 * tenantId/tier/limits/features/readOnly/downgradedAt/billingAnchorDay), not
 * just the tier's numeric caps. The caps this screen actually renders live at
 * `data.limits.limits` — yes, nested — and the raw per-tenant override bag
 * that was negotiated is a *separate* top-level field, `data.limitOverrides`.
 * `ResolvedLimits` and `LimitOverrides` below are named for what they are
 * rather than mirrored 1:1 against the wire shape, so a reader of this file
 * doesn't have to hold "limits.limits" in their head to follow the render.
 *
 * No Stripe identifier is ever in the payload to begin with (AC8 of
 * GRAFT-27.2 — `billing` carries presence booleans only), so there is nothing
 * to withhold here; the point is simply never to add one.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { ArrowLeftIcon } from "lucide-react";
import { IdChip, Pill, TierPill, When } from "@/components/admin/admin-ui";
import { TenantSidePanels } from "@/components/admin/tenant-side-panels";
import { TierOverrideDialog } from "@/components/admin/tier-override-dialog";

/** The tier's numeric caps as resolved for this tenant — `data.limits.limits`. */
export type ResolvedLimits = Record<string, number | null>;

/** The raw per-tenant override bag as stored on the tenant document. */
export type LimitOverrideBag = Record<string, number | null | boolean>;

/** Mirrors `TenantDetail` (src/server/services/admin-tenants.ts). */
export type TenantDetailView = {
  id: string;
  name: string;
  slug: string;
  tier: string;
  createdAt: string | null;
  readOnlyCount: number;
  hasLimitOverrides: boolean;
  billing: {
    hasCustomer: boolean;
    hasSubscription: boolean;
    graceExpiresAt: string | null;
    trialEndsAt: string | null;
  };
  /** The full resolved entitlement object — see the module docs. */
  limits: {
    limits: ResolvedLimits;
    [key: string]: unknown;
  };
  limitOverrides: LimitOverrideBag;
  readOnly: readonly string[];
  downgradedAt: string | null;
  billingAnchorDay: number;
};

type State =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error" }
  | { status: "ready"; tenant: TenantDetailView };

function formatLimitValue(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString();
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function TenantDetail({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  /**
   * Bumped by the tier-override control after a successful change, to re-run
   * the read below. The screen never patches its own copy of the tenant:
   * `readOnly` and the materialised limits are decided by
   * applyDowngradePolicy (src/server/services/billing.ts), so the only honest
   * way to show them is to ask the server again (GRAFT-27.4).
   */
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/v1/admin/tenants/${tenantId}`, {
          credentials: "include",
        });
        if (cancelled) return;
        if (response.status === 404) {
          setState({ status: "not-found" });
          return;
        }
        if (!response.ok) {
          setState({ status: "error" });
          return;
        }
        const body = (await response.json()) as { data: TenantDetailView };
        setState({ status: "ready", tenant: body.data });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, reloads]);

  if (state.status === "loading") {
    return <LoadingState label="Loading tenant…" />;
  }

  if (state.status === "not-found") {
    return (
      <ErrorState
        title="Tenant not found"
        description="This tenant doesn't exist, or the id in the URL is wrong."
        action={
          <Link href="/admin/tenants" className="text-sm underline underline-offset-2">
            Back to tenants
          </Link>
        }
      />
    );
  }

  if (state.status === "error") {
    return (
      <ErrorState
        title="Couldn't load this tenant"
        description="Please try again. If the problem persists, contact support."
        action={
          <Link href="/admin/tenants" className="text-sm underline underline-offset-2">
            Back to tenants
          </Link>
        }
      />
    );
  }

  const { tenant } = state;
  const resolvedLimits = Object.entries(tenant.limits.limits ?? {});
  const overriddenKeys = Object.keys(tenant.limitOverrides ?? {});
  const card = "flex flex-col gap-3 rounded-xl border border-border bg-card p-5";
  const cell = "flex items-center justify-between rounded-md border border-border px-3 py-1.5";

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/admin/tenants"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to tenants
      </Link>

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-graft-green/10 text-lg font-semibold text-graft-green-deep uppercase dark:text-graft-green-light">
            {(tenant.name || tenant.slug || "?").slice(0, 2)}
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {tenant.name || "(unnamed)"}
            </h1>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono">{tenant.slug}</span>
              <TierPill tier={tenant.tier} />
              {tenant.billing.hasSubscription ? <Pill tone="green">Subscribed</Pill> : null}
              {!tenant.billing.hasSubscription && tenant.billing.hasCustomer ? (
                <Pill tone="blue">Stripe customer</Pill>
              ) : null}
              {tenant.readOnly.length > 0 ? <Pill tone="amber">Frozen</Pill> : null}
              <span>
                created <When iso={tenant.createdAt} />
              </span>
              <IdChip id={tenant.id} />
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* GRAFT-29.3 AC4 — the entry point support actually uses: open the
              tenant, then see its activity, pre-filtered to it. */}
          <Link
            href={`/admin/activities?tenantId=${tenant.id}`}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
          >
            View activity
          </Link>
          <Link
            href={`/admin/audit?tenantId=${tenant.id}`}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
          >
            Audit trail
          </Link>
          {/* GRAFT-27.4 — the console's one mutation, on the screen that
              already shows the tenant it acts on. */}
          <TierOverrideDialog
            tenant={{
              id: tenant.id,
              name: tenant.name,
              slug: tenant.slug,
              tier: tenant.tier,
            }}
            onApplied={reload}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <section aria-labelledby="resolved-limits-heading" className={card}>
            <h2 id="resolved-limits-heading" className="text-sm font-semibold">
              Resolved limits
            </h2>
            {resolvedLimits.length === 0 ? (
              <EmptyState title="No resolved limits" />
            ) : (
              <ul className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-2">
                {resolvedLimits.map(([key, value]) => (
                  <li key={key} className={cell}>
                    <span className="text-muted-foreground">{key}</span>
                    <span className="font-medium">
                      {formatLimitValue(value)}
                      {overriddenKeys.includes(key) ? (
                        <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                          overridden
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            <section aria-labelledby="overrides-heading" className={card}>
              <h2 id="overrides-heading" className="text-sm font-semibold">
                Overridden keys
              </h2>
              {overriddenKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tenant.hasLimitOverrides
                    ? "This tenant has an override bag, but it's empty."
                    : "No overrides — this tenant runs its tier's defaults."}
                </p>
              ) : (
                <p className="text-sm">{overriddenKeys.join(", ")}</p>
              )}
            </section>

            <section aria-labelledby="freeze-heading" className={card}>
              <h2 id="freeze-heading" className="text-sm font-semibold">
                Frozen (read-only) resources
              </h2>
              {tenant.readOnly.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing is frozen.</p>
              ) : (
                <ul className="list-inside list-disc text-sm">
                  {tenant.readOnly.map((key) => (
                    <li key={key}>{key}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section aria-labelledby="billing-heading" className={card}>
            <h2 id="billing-heading" className="text-sm font-semibold">
              Billing
            </h2>
            <dl className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-2">
              <div className={cell}>
                <dt className="text-muted-foreground">Downgraded at</dt>
                <dd className="font-medium">{formatDate(tenant.downgradedAt)}</dd>
              </div>
              <div className={cell}>
                <dt className="text-muted-foreground">Billing anchor day</dt>
                <dd className="font-medium">{tenant.billingAnchorDay}</dd>
              </div>
              <div className={cell}>
                <dt className="text-muted-foreground">Trial ends</dt>
                <dd className="font-medium">{formatDate(tenant.billing.trialEndsAt)}</dd>
              </div>
              <div className={cell}>
                <dt className="text-muted-foreground">Grace ends</dt>
                <dd className="font-medium">{formatDate(tenant.billing.graceExpiresAt)}</dd>
              </div>
            </dl>
          </section>
        </div>

        <TenantSidePanels tenantId={tenant.id} />
      </div>
    </div>
  );
}
