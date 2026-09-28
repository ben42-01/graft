"use client";

/**
 * `/admin/activities` — the Activity Monitor. Supersedes the GRAFT-29.3
 * `ActivityTable` (a filterable list) with a monitoring view over the same
 * data: a time range, a live mode that re-reads every few seconds, a volume
 * chart split by outcome, breakdowns by family / action / tenant / actor that
 * double as one-click filters, and the event stream underneath.
 *
 * Two endpoints, one set of filters: `GET /api/v1/admin/activities/summary`
 * for the aggregates and `GET /api/v1/admin/activities` for the stream, both
 * handed the identical query — so the charts always describe the rows below
 * them. Everything re-queries the server; nothing filters a loaded page.
 *
 * Kept from ActivityTable, and still true: the family filter is a closed list
 * hand-typed from `ACTIVITY_REGISTRY` (never free text — an unregistered
 * action is a 400), context is rendered through per-family human labels, never
 * as raw JSON, and "load more" de-duplicates by id.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAdminList, useAdminQuery, useDebounced } from "./admin-api";
import { BreakdownBars, bucketLabels, ColumnChart } from "./admin-charts";
import {
  DataTable,
  formatNumber,
  IdChip,
  ListBody,
  LoadMore,
  OutcomePill,
  PageHeader,
  Panel,
  Pill,
  RefreshButton,
  Segmented,
  StatTile,
  When,
} from "./admin-ui";

/** Mirrors `ActivitySummary` (src/server/services/admin-activities.ts). */
export type ActivityRow = {
  id: string;
  tenantId: string;
  actorType: "customer" | "system" | "admin";
  actorId: string | null;
  action: string;
  ok: boolean;
  at: string;
  context: Readonly<Record<string, unknown>>;
};

/** Mirrors `ActivitySummaryReport` (src/server/services/admin-activity-summary.ts). */
export type ActivityReport = {
  range: { from: string; to: string; bucket: "hour" | "day" };
  total: number;
  ok: number;
  failed: number;
  failureRate: number;
  byFamily: { family: string; total: number; failed: number }[];
  byActorType: { actorType: string; total: number; failed: number }[];
  topActions: { action: string; total: number; failed: number }[];
  topTenants: {
    tenantId: string;
    tenantName: string | null;
    tenantSlug: string | null;
    total: number;
    failed: number;
  }[];
  series: { at: string; ok: number; failed: number }[];
};

/**
 * The closed action families, hand-typed from `ACTIVITY_REGISTRY`
 * (src/server/services/activity-log.ts) — a server module, never imported here.
 */
export const FAMILY_OPTIONS = [
  { value: "all", label: "All families" },
  { value: "notify.email", label: "Notify: email" },
  { value: "billing.subscription", label: "Billing: subscription" },
  { value: "billing.payment", label: "Billing: payment" },
  { value: "account", label: "Account" },
  { value: "entity", label: "Entity" },
] as const;

const ACTOR_OPTIONS = [
  { value: "all", label: "All actors" },
  { value: "customer", label: "Customer" },
  { value: "system", label: "System" },
  { value: "admin", label: "Admin" },
] as const;

const OUTCOME_OPTIONS = [
  { value: "all", label: "All" },
  { value: "true", label: "Succeeded" },
  { value: "false", label: "Failed" },
] as const;

const HOUR = 60 * 60 * 1000;
const RANGE_OPTIONS = [
  { value: "1h", label: "1h", ms: HOUR },
  { value: "24h", label: "24h", ms: 24 * HOUR },
  { value: "7d", label: "7d", ms: 7 * 24 * HOUR },
  { value: "30d", label: "30d", ms: 30 * 24 * HOUR },
  { value: "90d", label: "90d", ms: 90 * 24 * HOUR },
] as const;
type RangeKey = (typeof RANGE_OPTIONS)[number]["value"] | "custom";

const LIVE_MS = 10_000;

/** Per-family human labels for context fields — never a raw JSON dump. */
export const CONTEXT_FIELD_LABELS: Record<string, Record<string, string>> = {
  "notify.email": { template: "Template", to: "Recipient" },
  "billing.subscription": { fromTier: "From tier", toTier: "To tier", reason: "Reason" },
  "billing.payment": {
    amountCents: "Amount",
    currency: "Currency",
    failureCode: "Failure code",
  },
  account: { method: "Method" },
  entity: { entityDefId: "Entity definition", entityType: "Entity type", recordId: "Record" },
};

export function familyOf(action: string): string {
  const cut = action.lastIndexOf(".");
  return cut === -1 ? action : action.slice(0, cut);
}

export function formatContextValue(family: string, field: string, value: unknown): string {
  if (family === "billing.payment" && field === "amountCents" && typeof value === "number") {
    return (value / 100).toFixed(2);
  }
  if (value === null || value === undefined) return "—";
  return String(value);
}

const familyLabel = (family: string) =>
  FAMILY_OPTIONS.find((o) => o.value === family)?.label ?? family;

function actionLabel(action: string): string {
  const leaf = action.slice(action.lastIndexOf(".") + 1);
  return `${familyLabel(familyOf(action))} · ${leaf.replace(/_/g, " ")}`;
}

function toCsv(rows: ActivityRow[], names: Map<string, string>): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["at", "tenantId", "tenant", "action", "actorType", "actorId", "ok", "context"].join(","),
  ];
  for (const r of rows) {
    lines.push(
      [
        r.at,
        r.tenantId,
        names.get(r.tenantId) ?? "",
        r.action,
        r.actorType,
        r.actorId ?? "",
        r.ok,
        JSON.stringify(r.context),
      ]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** `<input type="datetime-local">` value for a Date, in local time. */
const toLocalInput = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ActivityMonitor() {
  const searchParams = useSearchParams();
  const [tenantId, setTenantId] = useState(searchParams.get("tenantId") ?? "");
  const [tenantLabel, setTenantLabel] = useState<string | null>(null);
  const [family, setFamily] = useState("all");
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState("all");
  const [outcome, setOutcome] = useState<(typeof OUTCOME_OPTIONS)[number]["value"]>("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [range, setRange] = useState<RangeKey>("7d");
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => {
    const now = new Date();
    return { from: toLocalInput(new Date(now.getTime() - 24 * HOUR)), to: toLocalInput(now) };
  });
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Live mode moves the window forward by bumping `tick`, which re-derives
  // `from`/`to` below — and so the request key — rather than polling a frozen
  // range that would never show anything new.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((t) => t + 1), LIVE_MS);
    return () => clearInterval(timer);
  }, [live]);

  const span = useMemo(() => {
    if (range === "custom") {
      const from = new Date(custom.from);
      const to = new Date(custom.to);
      return {
        from: Number.isNaN(from.getTime()) ? undefined : from.toISOString(),
        to: Number.isNaN(to.getTime()) ? undefined : to.toISOString(),
      };
    }
    const ms = RANGE_OPTIONS.find((o) => o.value === range)?.ms ?? 7 * 24 * HOUR;
    const now = Date.now();
    return { from: new Date(now - ms).toISOString(), to: new Date(now).toISOString() };
    // `tick` is the live-mode clock; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick is intentional
  }, [range, custom, tick]);

  const params = {
    tenantId,
    action: action || (family !== "all" && `${family}.`),
    actorType: actorType !== "all" && actorType,
    ok: outcome !== "all" && outcome,
    q,
    from: span.from,
    to: span.to,
  };

  const summary = useAdminQuery<ActivityReport>("/api/v1/admin/activities/summary", params);
  const stream = useAdminList<ActivityRow>("/api/v1/admin/activities", params);
  const report = summary.data;

  const tenantNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const t of report?.topTenants ?? []) {
      const name = t.tenantName ?? t.tenantSlug;
      if (name) names.set(t.tenantId, name);
    }
    if (tenantId && tenantLabel) names.set(tenantId, tenantLabel);
    return names;
  }, [report, tenantId, tenantLabel]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearAll = () => {
    setTenantId("");
    setTenantLabel(null);
    setFamily("all");
    setAction("");
    setActorType("all");
    setOutcome("all");
    setSearch("");
  };

  const filtered =
    Boolean(tenantId || action || q) ||
    family !== "all" ||
    actorType !== "all" ||
    outcome !== "all";

  const zoomTo = (index: number) => {
    const bucket = report?.series[index];
    if (!report || !bucket) return;
    const start = new Date(bucket.at);
    const end = new Date(start.getTime() + (report.range.bucket === "hour" ? HOUR : 24 * HOUR));
    setLive(false);
    setRange("custom");
    setCustom({ from: toLocalInput(start), to: toLocalInput(end) });
  };

  const topFamily = report?.byFamily[0];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity monitor"
        description="What customers, the system and admins did across every account — sign-ins, emails, billing events and data changes."
        actions={
          <>
            <Button
              type="button"
              variant={live ? "default" : "outline"}
              size="sm"
              aria-pressed={live}
              onClick={() => {
                setLive((v) => !v);
                if (range === "custom") setRange("1h");
              }}
              className={cn(live && "bg-graft-green text-white hover:bg-graft-green-deep")}
            >
              {live ? (
                <>
                  <span className="relative flex size-2" aria-hidden="true">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-white" />
                  </span>
                  Live
                  <PauseIcon aria-hidden="true" />
                </>
              ) : (
                <>
                  <PlayIcon aria-hidden="true" />
                  Go live
                </>
              )}
            </Button>
            <RefreshButton
              onClick={() => setTick((t) => t + 1)}
              refreshing={summary.refreshing || stream.status === "loading"}
            />
          </>
        }
      />

      {/* Range + filters: one row of controls above everything they drive. */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Time range"
            value={range}
            options={[
              ...RANGE_OPTIONS.map(({ value, label }) => ({ value, label })),
              { value: "custom" as const, label: "Custom" },
            ]}
            onChange={(value) => {
              setRange(value);
              if (value === "custom") setLive(false);
            }}
          />
          {range === "custom" ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Input
                type="datetime-local"
                aria-label="From"
                value={custom.from}
                onChange={(event) => setCustom((c) => ({ ...c, from: event.target.value }))}
                className="w-auto bg-background"
              />
              <span className="text-muted-foreground">to</span>
              <Input
                type="datetime-local"
                aria-label="To"
                value={custom.to}
                onChange={(event) => setCustom((c) => ({ ...c, to: event.target.value }))}
                className="w-auto bg-background"
              />
            </div>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {report ? (
              <>
                {new Date(report.range.from).toLocaleString()} –{" "}
                {new Date(report.range.to).toLocaleString()} · by {report.range.bucket}
              </>
            ) : null}
          </span>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <div className="relative flex-1 lg:min-w-56">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Search activity"
              placeholder="Search template, reason, entity type…"
              value={search}
              maxLength={60}
              onChange={(event) => setSearch(event.target.value)}
              className="bg-background pl-8"
            />
          </div>
          <Select
            value={family}
            onValueChange={(value) => {
              setFamily(value);
              setAction("");
            }}
          >
            <SelectTrigger aria-label="Filter by family" className="bg-background lg:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FAMILY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actorType} onValueChange={setActorType}>
            <SelectTrigger aria-label="Filter by actor type" className="bg-background lg:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTOR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Segmented
            label="Outcome"
            value={outcome}
            options={OUTCOME_OPTIONS}
            onChange={setOutcome}
          />
        </div>
        {filtered ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Filtered by</span>
            {tenantId ? (
              <FilterChip
                label={`Account: ${tenantNames.get(tenantId) ?? tenantId.slice(-8)}`}
                onClear={() => {
                  setTenantId("");
                  setTenantLabel(null);
                }}
              />
            ) : null}
            {action ? (
              <FilterChip label={`Action: ${action}`} onClear={() => setAction("")} />
            ) : null}
            {!action && family !== "all" ? (
              <FilterChip label={familyLabel(family)} onClear={() => setFamily("all")} />
            ) : null}
            {actorType !== "all" ? (
              <FilterChip label={`Actor: ${actorType}`} onClear={() => setActorType("all")} />
            ) : null}
            {outcome !== "all" ? (
              <FilterChip
                label={outcome === "false" ? "Failed only" : "Succeeded only"}
                onClear={() => setOutcome("all")}
              />
            ) : null}
            {q ? <FilterChip label={`“${q}”`} onClear={() => setSearch("")} /> : null}
            <button
              type="button"
              onClick={clearAll}
              className="font-medium text-graft-green-deep hover:underline dark:text-graft-green-light"
            >
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Events" value={report?.total ?? "—"} hint="In the selected range" />
        <StatTile
          label="Failed"
          value={report?.failed ?? "—"}
          tone={report && report.failed > 0 ? "critical" : "default"}
          hint={report ? `${(report.failureRate * 100).toFixed(1)}% failure rate` : undefined}
        />
        <StatTile label="Succeeded" value={report?.ok ?? "—"} />
        <StatTile
          label="Busiest family"
          value={topFamily ? familyLabel(topFamily.family) : "—"}
          hint={topFamily ? `${formatNumber(topFamily.total)} events` : undefined}
        />
      </div>

      <Panel
        title="Volume"
        description={
          report
            ? `Events per ${report.range.bucket} by outcome — click a column to zoom into it`
            : undefined
        }
      >
        {report ? (
          <ColumnChart
            caption="Activity volume by outcome"
            height={180}
            series={[
              { key: "ok", label: "Succeeded", color: "var(--chart-ok)" },
              { key: "failed", label: "Failed", color: "var(--chart-fail)" },
            ]}
            data={report.series.map((b) => ({
              ...bucketLabels(b.at, report.range.bucket),
              ok: b.ok,
              failed: b.failed,
            }))}
            onSelect={zoomTo}
          />
        ) : (
          <div className="h-48 animate-pulse rounded-md bg-muted" />
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="By family" description="Click to filter">
          <BreakdownBars
            rows={(report?.byFamily ?? []).map((row) => ({
              key: row.family,
              label: familyLabel(row.family),
              value: row.total,
              secondary:
                row.failed > 0 ? (
                  <span className="text-destructive">{row.failed} failed</span>
                ) : undefined,
            }))}
            onSelect={(key) => {
              setFamily(key);
              setAction("");
            }}
          />
        </Panel>
        <Panel title="Top actions" description="Click to filter to one action">
          <BreakdownBars
            rows={(report?.topActions ?? []).map((row) => ({
              key: row.action,
              label: <span className="font-mono text-xs">{row.action}</span>,
              value: row.total,
              secondary:
                row.failed > 0 ? (
                  <span className="text-destructive">{row.failed} failed</span>
                ) : undefined,
            }))}
            onSelect={(key) => {
              setAction(key);
              setFamily(familyOf(key));
            }}
          />
        </Panel>
        <Panel title="Most active accounts" description="Click to focus one account">
          <BreakdownBars
            rows={(report?.topTenants ?? []).map((row) => ({
              key: row.tenantId,
              label: row.tenantName ?? row.tenantSlug ?? row.tenantId.slice(-8),
              value: row.total,
              secondary:
                row.failed > 0 ? (
                  <span className="text-destructive">{row.failed} failed</span>
                ) : undefined,
            }))}
            onSelect={(key) => {
              setTenantId(key);
              setTenantLabel(tenantNames.get(key) ?? null);
            }}
          />
          {report && report.byActorType.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
              {report.byActorType.map((row) => (
                <button
                  key={row.actorType}
                  type="button"
                  onClick={() => setActorType(row.actorType)}
                >
                  <Pill tone={actorType === row.actorType ? "green" : "neutral"}>
                    <span className="capitalize">{row.actorType}</span> ·{" "}
                    {formatNumber(row.total)}
                  </Pill>
                </button>
              ))}
            </div>
          ) : null}
        </Panel>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Event stream</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={stream.rows.length === 0}
            onClick={() =>
              download(
                `graft-activity-${new Date().toISOString().slice(0, 19)}.csv`,
                toCsv(stream.rows, tenantNames),
              )
            }
          >
            <DownloadIcon aria-hidden="true" />
            Export CSV
          </Button>
        </div>
        <ListBody
          status={stream.status}
          error={stream.status === "error" ? stream.error : undefined}
          count={stream.rows.length}
          label="activity"
          onRetry={() => void stream.reload()}
          empty={{
            title: "No activity matches",
            description: filtered
              ? "Nothing matches the current filters."
              : "No activity has been recorded in this range.",
          }}
        >
          <DataTable>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Details</span>
                </th>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Account</th>
                <th scope="col">Actor</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {stream.rows.map((row) => {
                const isOpen = expanded.has(row.id);
                const fam = familyOf(row.action);
                const fields = CONTEXT_FIELD_LABELS[fam] ?? {};
                const entries = Object.entries(fields).filter(
                  ([field]) => row.context[field] !== undefined,
                );
                return (
                  <Fragment key={row.id}>
                    <tr className={cn(!row.ok && "bg-destructive/[0.03]")}>
                      <td className="w-8">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide details" : "Show details"}
                          onClick={() => toggle(row.id)}
                        >
                          {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                        </Button>
                      </td>
                      <td className="text-muted-foreground">
                        <When iso={row.at} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-left hover:text-graft-green-deep dark:hover:text-graft-green-light"
                          title="Filter to this action"
                          onClick={() => {
                            setAction(row.action);
                            setFamily(fam);
                          }}
                        >
                          {actionLabel(row.action)}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-left hover:text-graft-green-deep dark:hover:text-graft-green-light"
                          title="Filter to this account"
                          onClick={() => {
                            setTenantId(row.tenantId);
                            setTenantLabel(tenantNames.get(row.tenantId) ?? null);
                          }}
                        >
                          {tenantNames.get(row.tenantId) ?? (
                            <span className="font-mono text-xs">{row.tenantId.slice(-8)}</span>
                          )}
                        </button>
                      </td>
                      <td className="capitalize">{row.actorType}</td>
                      <td>
                        <OutcomePill ok={row.ok} />
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="bg-muted/30">
                        <td />
                        <td colSpan={5}>
                          <dl className="grid grid-cols-1 gap-x-8 gap-y-1 py-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                            {entries.map(([field, label]) => (
                              <div
                                key={field}
                                className="flex items-center justify-between gap-3"
                              >
                                <dt className="text-muted-foreground">{label}</dt>
                                <dd className="font-medium">
                                  {formatContextValue(fam, field, row.context[field])}
                                </dd>
                              </div>
                            ))}
                            <div className="flex items-center justify-between gap-3">
                              <dt className="text-muted-foreground">Account</dt>
                              <dd>
                                <Link
                                  href={`/admin/tenants/${row.tenantId}`}
                                  className="font-medium hover:underline"
                                >
                                  Open
                                </Link>{" "}
                                <IdChip id={row.tenantId} />
                              </dd>
                            </div>
                            {row.actorId ? (
                              <div className="flex items-center justify-between gap-3">
                                <dt className="text-muted-foreground">Actor id</dt>
                                <dd>
                                  <IdChip id={row.actorId} />
                                </dd>
                              </div>
                            ) : null}
                            <div className="flex items-center justify-between gap-3">
                              <dt className="text-muted-foreground">At</dt>
                              <dd className="font-medium">
                                {new Date(row.at).toLocaleString()}
                              </dd>
                            </div>
                          </dl>
                          {entries.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No further detail.</p>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </DataTable>
        </ListBody>
        <LoadMore
          hasMore={stream.hasMore}
          loading={stream.loadingMore}
          onClick={() => void stream.loadMore()}
          shown={stream.rows.length}
        />
      </section>
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-graft-green/30 bg-graft-green/10 py-0.5 pr-1 pl-2 font-medium text-graft-green-deep dark:text-graft-green-light">
      {label}
      <button
        type="button"
        aria-label={`Remove filter ${label}`}
        onClick={onClear}
        className="rounded-full p-0.5 hover:bg-graft-green/20"
      >
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}
