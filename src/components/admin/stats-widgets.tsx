"use client";

/**
 * Stat widgets at the top of `/admin/tenants` — a summary strip over
 * `GET /api/v1/admin/stats` (src/server/services/admin-stats.ts). No
 * charting library: five tenants or five thousand, this is a handful of
 * numbers and a tier breakdown bar, and a dependency buys nothing here.
 *
 * Same fetch/loading/error shape as `TenantTable`, deliberately duplicated
 * rather than shared — this widget has no search, filter, or pagination, so
 * the abstraction the table's `fetchTenants`/`State` machinery earns isn't
 * worth it for one GET on mount.
 */
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TIERS, type Tier } from "@/server/tiers";

/** Mirrors `AdminStats` (src/server/services/admin-stats.ts). */
type AdminStats = {
  totalTenants: number;
  byTier: Record<Tier, number>;
  frozenTenants: number;
  inTrial: number;
  inGrace: number;
};

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; stats: AdminStats };

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  premium: "Premium",
  enterprise: "Enterprise",
};

// The theme is a neutral grayscale (no chart/accent tokens beyond
// `destructive`), so `bg-primary` and `bg-foreground` render as the same
// near-black and were indistinguishable in the bar — a 3-step lightness ramp
// instead, checked visually at http://localhost:3000/admin/tenants.
const TIER_BAR_COLOR: Record<Tier, string> = {
  free: "bg-muted-foreground/30",
  premium: "bg-muted-foreground",
  enterprise: "bg-foreground",
};

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-2xl font-semibold tabular-nums">{value}</CardContent>
    </Card>
  );
}

function TierBreakdown({ total, byTier }: { total: number; byTier: Record<Tier, number> }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-normal text-muted-foreground">By tier</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {TIERS.map((tier) => {
            const count = byTier[tier];
            const pct = total > 0 ? (count / total) * 100 : 0;
            return count > 0 ? (
              <div
                key={tier}
                className={TIER_BAR_COLOR[tier]}
                style={{ width: `${pct}%` }}
                title={`${TIER_LABEL[tier]}: ${count}`}
              />
            ) : null;
          })}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {TIERS.map((tier) => (
            <span key={tier} className="flex items-center gap-1.5">
              <span
                className={`inline-block size-2 rounded-full ${TIER_BAR_COLOR[tier]}`}
                aria-hidden="true"
              />
              {TIER_LABEL[tier]}: {byTier[tier]}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function AdminStatsWidgets() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/v1/admin/stats", { credentials: "include" });
        if (!response.ok) throw new Error("request failed");
        const body = (await response.json()) as { data: AdminStats };
        if (!cancelled) setState({ status: "ready", stats: body.data });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <LoadingState label="Loading stats…" />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        title="Couldn't load stats"
        description="Please try again. If the problem persists, contact support."
      />
    );
  }

  const { stats } = state;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Tenants" value={stats.totalTenants} />
      <StatCard label="Frozen" value={stats.frozenTenants} />
      <StatCard label="In trial" value={stats.inTrial} />
      <StatCard label="In grace" value={stats.inGrace} />
      <div className="col-span-2 sm:col-span-4">
        <TierBreakdown total={stats.totalTenants} byTier={stats.byTier} />
      </div>
    </div>
  );
}
