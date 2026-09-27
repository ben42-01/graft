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
import { BlocksIcon, ClockAlertIcon, HourglassIcon, SnowflakeIcon } from "lucide-react";
import { SegmentBar } from "@/components/admin/admin-charts";
import { Panel, StatTile } from "@/components/admin/admin-ui";
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

// The first three categorical chart slots (globals.css `--chart-*`), the only
// three validated for colour-blind separation across all pairs. This used to
// be a grayscale ramp, back when the theme had no chart tokens at all.
const TIER_COLOR: Record<Tier, string> = {
  free: "var(--chart-1)",
  premium: "var(--chart-2)",
  enterprise: "var(--chart-3)",
};

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
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <StatTile label="Accounts" value={stats.totalTenants} icon={BlocksIcon} />
      <StatTile label="In trial" value={stats.inTrial} icon={HourglassIcon} />
      <StatTile
        label="In grace"
        value={stats.inGrace}
        icon={ClockAlertIcon}
        tone={stats.inGrace > 0 ? "warning" : "default"}
      />
      <StatTile
        label="Frozen"
        value={stats.frozenTenants}
        icon={SnowflakeIcon}
        tone={stats.frozenTenants > 0 ? "warning" : "default"}
      />
      <Panel title="By tier" className="col-span-2 gap-3 p-4 lg:col-span-1">
        <SegmentBar
          segments={TIERS.map((tier) => ({
            label: TIER_LABEL[tier],
            value: stats.byTier[tier],
            color: TIER_COLOR[tier],
          }))}
        />
      </Panel>
    </div>
  );
}
