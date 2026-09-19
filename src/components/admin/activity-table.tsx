"use client";

/**
 * The `/admin/activities` list (GRAFT-29.3) — every activity row across every
 * tenant, read from `GET /api/v1/admin/activities`
 * (src/server/services/admin-activities.ts `ActivitySummary`).
 *
 * Same conventions as `tenant-table.tsx` in every particular that applies:
 * every filter (including free-text search) re-queries the server — never a
 * client-side filter of whatever page happens to be loaded (AC1) — search is
 * debounced by `SEARCH_DEBOUNCE_MS`, and "load more" advances by the server's
 * opaque `meta.cursor` and de-dupes by id rather than trusting the server
 * never to hand back a row already on screen (AC3).
 *
 * The action filter (AC2) is a dropdown of the five closed families this
 * table mirrors from `ACTIVITY_REGISTRY`
 * (src/server/services/activity-log.ts) — not free text, so an operator can
 * never send an unregistered `action` and walk straight into GRAFT-29.2 AC3's
 * 400. `activity-log.ts` is a server module (it imports the Mongo driver) and
 * is never imported from this client component for that reason — same
 * argument `tenant-table.tsx` makes for hand-typing `TIER_OPTIONS` instead of
 * importing `TIERS`.
 *
 * No mutation lives here — this screen only ever reads, same as
 * `tenant-table.tsx`.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from "lucide-react";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Mirrors `ActivitySummary` (src/server/services/admin-activities.ts). */
export type ActivitySummary = {
  id: string;
  tenantId: string;
  actorType: "customer" | "system" | "admin";
  actorId: string | null;
  action: string;
  ok: boolean;
  at: string;
  context: Readonly<Record<string, unknown>>;
};

type Page = { data: ActivitySummary[]; meta: { cursor: string | null; hasMore: boolean } };

type Filters = {
  tenantId: string;
  family: string;
  actorType: string;
  from: string;
  to: string;
  query: string;
};

type State =
  | { status: "loading" }
  | { status: "error" }
  | ({
      status: "ready";
      rows: ActivitySummary[];
      cursor: string | null;
      hasMore: boolean;
    } & Filters);

/** Matches `tenant-table.tsx`'s search debounce. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The five closed action families (AC2), hand-typed from
 * `ACTIVITY_REGISTRY`'s keys (src/server/services/activity-log.ts) rather
 * than imported — see the module docs. `activity-log.test.ts` and
 * `admin-activities.test.ts` both fail loudly if the server registry's keys
 * ever drift from this list, since the same five strings are asserted there
 * against `ACTIVITY_REGISTRY` directly.
 */
const FAMILY_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "notify.email", label: "Notify: email" },
  { value: "billing.subscription", label: "Billing: subscription" },
  { value: "billing.payment", label: "Billing: payment" },
  { value: "account", label: "Account" },
  { value: "entity", label: "Entity" },
] as const;

const ACTOR_TYPE_OPTIONS = [
  { value: "all", label: "All actors" },
  { value: "customer", label: "Customer" },
  { value: "system", label: "System" },
  { value: "admin", label: "Admin" },
] as const;

/** AC7 — human labels for each family's context fields, never a raw JSON dump. */
const CONTEXT_FIELD_LABELS: Record<string, Record<string, string>> = {
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

function familyOf(action: string): string {
  const cut = action.lastIndexOf(".");
  return cut === -1 ? action : action.slice(0, cut);
}

function formatContextValue(family: string, field: string, value: unknown): string {
  if (family === "billing.payment" && field === "amountCents" && typeof value === "number") {
    return (value / 100).toFixed(2);
  }
  if (value === null || value === undefined) return "—";
  return String(value);
}

function actionLabel(action: string): string {
  const option = FAMILY_OPTIONS.find((o) => o.value === familyOf(action));
  const leaf = action.slice(action.lastIndexOf(".") + 1);
  return option ? `${option.label} · ${leaf}` : action;
}

async function fetchActivities(cursor: string | null, filters: Filters): Promise<Page | null> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (filters.tenantId) params.set("tenantId", filters.tenantId);
  if (filters.family !== "all") params.set("action", `${filters.family}.`);
  if (filters.actorType !== "all") params.set("actorType", filters.actorType);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.query) params.set("q", filters.query);
  const qs = params.toString();
  try {
    const response = await fetch(
      qs ? `/api/v1/admin/activities?${qs}` : "/api/v1/admin/activities",
      { credentials: "include" },
    );
    if (!response.ok) return null;
    return (await response.json()) as Page;
  } catch {
    return null;
  }
}

export function ActivityTable({ initialTenantId = "" }: { initialTenantId?: string }) {
  const tenantLocked = initialTenantId !== "";
  const [state, setState] = useState<State>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("all");
  const [actorType, setActorType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const loadingRef = useRef(false);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    let cancelled = false;
    const filters: Filters = { tenantId: initialTenantId, family, actorType, from, to, query };
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void fetchActivities(null, filters).then((body) => {
      if (cancelled) return;
      if (!body) {
        setState({ status: "error" });
        return;
      }
      setState({
        status: "ready",
        rows: body.data,
        cursor: body.meta.cursor,
        hasMore: body.meta.hasMore,
        ...filters,
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialTenantId is fixed per mount
  }, [query, family, actorType, from, to]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.hasMore || !state.cursor || loadingRef.current)
      return;
    loadingRef.current = true;
    setLoadingMore(true);
    const forFilters: Filters = {
      tenantId: state.tenantId,
      family: state.family,
      actorType: state.actorType,
      from: state.from,
      to: state.to,
      query: state.query,
    };
    const body = await fetchActivities(state.cursor, forFilters);
    loadingRef.current = false;
    setLoadingMore(false);
    if (!body) return;
    setState((prev) => {
      if (
        prev.status !== "ready" ||
        prev.tenantId !== forFilters.tenantId ||
        prev.family !== forFilters.family ||
        prev.actorType !== forFilters.actorType ||
        prev.from !== forFilters.from ||
        prev.to !== forFilters.to ||
        prev.query !== forFilters.query
      )
        return prev;
      // AC3 — de-duplicate by id: a fast-fingered "load more" click, or the
      // server handing back a row already on screen, must never double-append.
      const seen = new Set(prev.rows.map((row) => row.id));
      const additions = body.data.filter((row) => !seen.has(row.id));
      return {
        ...prev,
        rows: [...prev.rows, ...additions],
        cursor: body.meta.cursor,
        hasMore: body.meta.hasMore,
      };
    });
  }, [state]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (state.status === "loading") {
    return <LoadingState label="Loading activity…" />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        title="Couldn't load activity"
        description="Please try again. If the problem persists, contact support."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 sm:min-w-48">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search activity"
            placeholder="Search…"
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={family} onValueChange={setFamily}>
          <SelectTrigger aria-label="Filter by action" className="sm:w-52">
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
          <SelectTrigger aria-label="Filter by actor type" className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTOR_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          aria-label="From date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="sm:w-40"
        />
        <Input
          type="date"
          aria-label="To date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="sm:w-40"
        />
      </div>

      {tenantLocked ? (
        <p className="text-sm text-muted-foreground">
          Filtered to tenant <span className="font-mono">{initialTenantId}</span>.
        </p>
      ) : null}

      {state.rows.length === 0 ? (
        <EmptyState
          title="No activity matches"
          description={
            state.query ||
            state.family !== "all" ||
            state.actorType !== "all" ||
            state.from ||
            state.to
              ? "Nothing matches the current filters."
              : "No activity has been recorded yet."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Outcome
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => {
                const isOpen = expanded.has(row.id);
                const fields = CONTEXT_FIELD_LABELS[familyOf(row.action)] ?? {};
                const contextEntries = Object.entries(fields).filter(
                  ([field]) => row.context[field] !== undefined,
                );
                return (
                  <Fragment key={row.id}>
                    <tr className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {new Date(row.at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">{actionLabel(row.action)}</td>
                      <td className="px-3 py-2 capitalize">{row.actorType}</td>
                      <td className="px-3 py-2">{row.ok ? "Succeeded" : "Failed"}</td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide details" : "Show details"}
                          onClick={() => toggleExpanded(row.id)}
                        >
                          {isOpen ? (
                            <ChevronUpIcon className="size-4" aria-hidden="true" />
                          ) : (
                            <ChevronDownIcon className="size-4" aria-hidden="true" />
                          )}
                        </Button>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-border bg-muted/20">
                        <td colSpan={5} className="px-3 py-2">
                          {contextEntries.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No further detail.</p>
                          ) : (
                            <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                              {contextEntries.map(([field, label]) => (
                                <div key={field} className="flex items-center justify-between">
                                  <dt className="text-muted-foreground">{label}</dt>
                                  <dd className="font-medium">
                                    {formatContextValue(
                                      familyOf(row.action),
                                      field,
                                      row.context[field],
                                    )}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {state.hasMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
