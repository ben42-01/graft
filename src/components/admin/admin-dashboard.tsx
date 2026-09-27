"use client";

/**
 * `/admin` — the platform dashboard. One read of `GET /api/v1/admin/overview`
 * for the numbers and trends, plus two short list reads (newest accounts,
 * latest activity) so the first screen answers "what just happened" as well
 * as "how big is it". Refreshes itself every minute while open.
 */
import Link from "next/link";
import {
  ActivityIcon,
  ArrowRightIcon,
  BlocksIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileTextIcon,
  InboxIcon,
  PackageIcon,
  UsersIcon,
} from "lucide-react";
import { LoadingState } from "@/components/shell/loading-state";
import { ErrorState } from "@/components/shell/error-state";
import { useAdminQuery } from "./admin-api";
import { ColumnChart, dayLabels, SegmentBar } from "./admin-charts";
import {
  formatNumber,
  OutcomePill,
  PageHeader,
  Panel,
  RefreshButton,
  StatTile,
  TierPill,
  When,
} from "./admin-ui";

/** Mirrors `AdminOverview` (src/server/services/admin-overview.ts). */
export type AdminOverview = {
  tenants: {
    total: number;
    byTier: Record<"free" | "premium" | "enterprise", number>;
    new7d: number;
    new30d: number;
    frozen: number;
  };
  subscriptions: { active: number; inTrial: number; inGrace: number; withCustomer: number };
  users: {
    total: number;
    verified: number;
    platformAdmins: number;
    new7d: number;
    new30d: number;
  };
  content: {
    entityDefs: number;
    records: number;
    forms: number;
    publishedForms: number;
    submissions: number;
    orders: number;
  };
  activity: { last24h: number; failed24h: number };
  window: { from: string; days: number };
  series: {
    signups: { day: string; count: number }[];
    tenants: { day: string; count: number }[];
    activity: { day: string; ok: number; failed: number }[];
  };
};

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  tier: string;
  createdAt: string | null;
};
type ActivityRow = {
  id: string;
  tenantId: string;
  action: string;
  ok: boolean;
  at: string;
  actorType: string;
};

const POLL_MS = 60_000;

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

function NewestAccounts() {
  const query = useAdminQuery<TenantRow[]>("/api/v1/admin/tenants", { limit: "6" }, POLL_MS);
  return (
    <Panel
      title="Newest accounts"
      action={
        <Link
          href="/admin/tenants"
          className="text-xs font-medium text-graft-green-deep hover:underline dark:text-graft-green-light"
        >
          All accounts
        </Link>
      }
    >
      {query.status === "loading" && !query.data ? (
        <LoadingState label="Loading accounts…" />
      ) : query.data && query.data.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((tenant) => (
            <li key={tenant.id}>
              <Link
                href={`/admin/tenants/${tenant.id}`}
                className="flex items-center gap-3 py-2 text-sm hover:text-graft-green-deep dark:hover:text-graft-green-light"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase">
                  {(tenant.name || tenant.slug || "?").slice(0, 2)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{tenant.name || "(unnamed)"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    <When iso={tenant.createdAt} />
                  </span>
                </span>
                <TierPill tier={tenant.tier} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts yet.</p>
      )}
    </Panel>
  );
}

function LatestActivity() {
  const query = useAdminQuery<ActivityRow[]>(
    "/api/v1/admin/activities",
    { limit: "7" },
    POLL_MS,
  );
  return (
    <Panel
      title="Latest activity"
      action={
        <Link
          href="/admin/activities"
          className="text-xs font-medium text-graft-green-deep hover:underline dark:text-graft-green-light"
        >
          Open monitor
        </Link>
      }
    >
      {query.status === "loading" && !query.data ? (
        <LoadingState label="Loading activity…" />
      ) : query.data && query.data.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.action}</span>
              <span className="hidden text-xs text-muted-foreground capitalize sm:inline">
                {row.actorType}
              </span>
              <OutcomePill ok={row.ok} />
              <span className="w-24 text-right text-xs text-muted-foreground">
                <When iso={row.at} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      )}
    </Panel>
  );
}

export function AdminDashboard() {
  const overview = useAdminQuery<AdminOverview>("/api/v1/admin/overview", {}, POLL_MS);
  const data = overview.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Everything on the platform at a glance — accounts, people, revenue state and what is happening right now."
        actions={<RefreshButton onClick={overview.reload} refreshing={overview.refreshing} />}
      />

      {!data && overview.status === "loading" ? (
        <LoadingState label="Loading dashboard…" variant="page" />
      ) : null}
      {!data && overview.status === "error" ? (
        <ErrorState title="Couldn't load the dashboard" description={overview.error} />
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Accounts"
              value={data.tenants.total}
              hint={`+${formatNumber(data.tenants.new7d)} this week · +${formatNumber(data.tenants.new30d)} in 30 days`}
              href="/admin/tenants"
              icon={BlocksIcon}
            />
            <StatTile
              label="Users"
              value={data.users.total}
              hint={`${pct(data.users.verified, data.users.total)} verified · +${formatNumber(data.users.new7d)} this week`}
              href="/admin/users"
              icon={UsersIcon}
            />
            <StatTile
              label="Paying subscriptions"
              value={data.subscriptions.active}
              hint={`${formatNumber(data.subscriptions.inTrial)} in trial · ${formatNumber(data.subscriptions.inGrace)} in grace`}
              href="/admin/subscriptions"
              icon={CreditCardIcon}
            />
            <StatTile
              label="Activity · 24h"
              value={data.activity.last24h}
              hint={
                data.activity.failed24h > 0
                  ? `${formatNumber(data.activity.failed24h)} failed (${pct(data.activity.failed24h, data.activity.last24h)})`
                  : "No failures"
              }
              href="/admin/activities"
              icon={ActivityIcon}
              tone={data.activity.failed24h > 0 ? "critical" : "default"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="New users"
              description={`Signups per day, last ${data.window.days} days (UTC)`}
            >
              <ColumnChart
                caption="New users per day"
                series={[{ key: "count", label: "Signups", color: "var(--chart-brand)" }]}
                data={data.series.signups.map((d) => ({ ...dayLabels(d.day), count: d.count }))}
              />
            </Panel>
            <Panel
              title="Activity"
              description={`Events per day, last ${data.window.days} days (UTC)`}
            >
              <ColumnChart
                caption="Activity per day by outcome"
                series={[
                  { key: "ok", label: "Succeeded", color: "var(--chart-ok)" },
                  { key: "failed", label: "Failed", color: "var(--chart-fail)" },
                ]}
                data={data.series.activity.map((d) => ({
                  ...dayLabels(d.day),
                  ok: d.ok,
                  failed: d.failed,
                }))}
              />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Tier mix" description="Accounts by plan" className="lg:col-span-1">
              <SegmentBar
                segments={[
                  { label: "Free", value: data.tenants.byTier.free, color: "var(--chart-1)" },
                  {
                    label: "Premium",
                    value: data.tenants.byTier.premium,
                    color: "var(--chart-2)",
                  },
                  {
                    label: "Enterprise",
                    value: data.tenants.byTier.enterprise,
                    color: "var(--chart-3)",
                  },
                ]}
              />
              <dl className="grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm">
                {[
                  [
                    "Stripe customers",
                    data.subscriptions.withCustomer,
                    "/admin/subscriptions?billing=subscribed",
                  ],
                  [
                    "In trial",
                    data.subscriptions.inTrial,
                    "/admin/subscriptions?billing=trial",
                  ],
                  [
                    "In grace",
                    data.subscriptions.inGrace,
                    "/admin/subscriptions?billing=grace",
                  ],
                  ["Frozen", data.tenants.frozen, "/admin/subscriptions?billing=frozen"],
                ].map(([label, value, href]) => (
                  <Link
                    key={label as string}
                    href={href as string}
                    className="flex flex-col rounded-md p-1 hover:bg-muted/50"
                  >
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-lg font-semibold">{formatNumber(value as number)}</dd>
                  </Link>
                ))}
              </dl>
            </Panel>

            <Panel
              title="What's being built"
              description="Live content across every tenant"
              className="lg:col-span-2"
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatTile
                  label="Entities"
                  value={data.content.entityDefs}
                  href="/admin/entities"
                  icon={DatabaseIcon}
                />
                <StatTile label="Records" value={data.content.records} icon={DatabaseIcon} />
                <StatTile
                  label="Forms"
                  value={data.content.forms}
                  hint={`${formatNumber(data.content.publishedForms)} published`}
                  icon={FileTextIcon}
                />
                <StatTile
                  label="Submissions"
                  value={data.content.submissions}
                  icon={InboxIcon}
                />
                <StatTile label="Orders" value={data.content.orders} icon={PackageIcon} />
                <Link
                  href="/admin/sdk"
                  className="flex flex-col justify-between gap-2 rounded-xl border border-dashed border-graft-green/40 bg-graft-green/[0.04] p-4 text-sm hover:bg-graft-green/[0.08]"
                >
                  <span className="font-medium">Poke the API</span>
                  <span className="flex items-center gap-1 text-xs text-graft-green-deep dark:text-graft-green-light">
                    Open the SDK <ArrowRightIcon className="size-3" aria-hidden="true" />
                  </span>
                </Link>
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <NewestAccounts />
            <LatestActivity />
          </div>
        </>
      ) : null}
    </div>
  );
}
