"use client";

/**
 * The `/admin/tenants` list (GRAFT-27.3 AC1, AC5, AC6, AC10) — every tenant
 * in the database, read from `GET /api/v1/admin/tenants`
 * (src/server/services/admin-tenants.ts `TenantSummary`).
 *
 * Search and the tier filter both re-query the server (AC5): `q` is never a
 * client-side filter of whatever page happens to be loaded, so it finds the
 * six-hundredth tenant as readily as the first. Paging advances by the
 * server's opaque `meta.cursor` (AC6) and appends rows rather than fetching a
 * whole new "page 2" that could re-show one already on screen.
 *
 * No mutation control lives here — the tier-override action ships with
 * GRAFT-27.4. This screen only ever reads.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
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

/** Mirrors `TenantSummary` (src/server/services/admin-tenants.ts). */
export type TenantSummary = {
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
};

type Page = { data: TenantSummary[]; meta: { cursor: string | null; hasMore: boolean } };

type State =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      rows: TenantSummary[];
      cursor: string | null;
      hasMore: boolean;
      query: string;
      tier: string;
    };

/** How long typing has to pause before a search is sent — matches the
 * catalogue browser's debounce (src/components/public-form/catalogue-browser.tsx). */
const SEARCH_DEBOUNCE_MS = 300;

const TIER_OPTIONS = [
  { value: "all", label: "All tiers" },
  { value: "free", label: "Free" },
  { value: "premium", label: "Premium" },
  { value: "enterprise", label: "Enterprise" },
];

function freezeLabel(count: number): string {
  return count > 0 ? `Frozen (${count})` : "—";
}

function billingLabel(billing: TenantSummary["billing"]): string {
  if (billing.trialEndsAt)
    return `Trial until ${new Date(billing.trialEndsAt).toLocaleDateString()}`;
  if (billing.graceExpiresAt)
    return `Grace until ${new Date(billing.graceExpiresAt).toLocaleDateString()}`;
  return "—";
}

async function fetchTenants(
  cursor: string | null,
  q: string,
  tier: string,
): Promise<Page | null> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (q) params.set("q", q);
  if (tier !== "all") params.set("tier", tier);
  const qs = params.toString();
  try {
    const response = await fetch(qs ? `/api/v1/admin/tenants?${qs}` : "/api/v1/admin/tenants", {
      credentials: "include",
    });
    if (!response.ok) return null;
    return (await response.json()) as Page;
  } catch {
    return null;
  }
}

export function TenantTable() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void fetchTenants(null, query, tier).then((body) => {
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
        query,
        tier,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [query, tier]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.hasMore || !state.cursor || loadingRef.current)
      return;
    loadingRef.current = true;
    setLoadingMore(true);
    const forQuery = state.query;
    const forTier = state.tier;
    const body = await fetchTenants(state.cursor, forQuery, forTier);
    loadingRef.current = false;
    setLoadingMore(false);
    if (!body) return;
    setState((prev) => {
      if (prev.status !== "ready" || prev.query !== forQuery || prev.tier !== forTier)
        return prev;
      // De-duplicate by id: the cursor is issued against a stable sort, but a
      // fast-fingered "load more" click while a request is already in flight
      // must never be able to double-append the same row (AC6).
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

  if (state.status === "loading") {
    return <LoadingState label="Loading tenants…" />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        title="Couldn't load tenants"
        description="Please try again. If the problem persists, contact support."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search tenants"
            placeholder="Search by name or slug…"
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger aria-label="Filter by tier" className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {state.rows.length === 0 ? (
        <EmptyState
          title="No tenants match"
          description={
            state.query
              ? `Nothing matches “${state.query}”.`
              : "No tenants exist for this filter yet."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Slug
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Tier
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Freeze
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Trial / grace
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/tenants/${row.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {row.name || "(unnamed)"}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{row.slug}</td>
                  <td className="px-3 py-2 capitalize">{row.tier}</td>
                  <td className="px-3 py-2">{freezeLabel(row.readOnlyCount)}</td>
                  <td className="px-3 py-2">{billingLabel(row.billing)}</td>
                </tr>
              ))}
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
