"use client";

/**
 * `/admin/subscriptions` — the billing lens on accounts: who is paying, who is
 * in trial or grace and when that ends, who is frozen after a downgrade, and
 * who has never touched Stripe.
 *
 * Reads `GET /api/v1/admin/tenants` with its `billing` filter (the same list
 * the Accounts screen uses, so the two can never disagree) plus the overview
 * counts for the tiles. Stripe ids are never shown — the API reports presence
 * only (admin-tenants.ts AC8).
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminList, useAdminQuery, useDebounced } from "./admin-api";
import type { AdminOverview } from "./admin-dashboard";
import {
  DataTable,
  ListBody,
  LoadMore,
  PageHeader,
  Pill,
  RefreshButton,
  Segmented,
  StatTile,
  TierPill,
  When,
} from "./admin-ui";
import type { TenantSummary } from "./tenant-table";

const BILLING_OPTIONS = [
  { value: "all", label: "All" },
  { value: "subscribed", label: "Paying" },
  { value: "trial", label: "Trial" },
  { value: "grace", label: "Grace" },
  { value: "frozen", label: "Frozen" },
  { value: "none", label: "No billing" },
] as const;

type BillingFilter = (typeof BILLING_OPTIONS)[number]["value"];

const isBillingFilter = (value: string | null): value is BillingFilter =>
  BILLING_OPTIONS.some((o) => o.value === value);

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

/** The one status that matters most for a row, most urgent first. */
function StatusPill({ row }: { row: TenantSummary }) {
  const now = Date.now();
  if (row.billing.graceExpiresAt && new Date(row.billing.graceExpiresAt).getTime() > now) {
    return <Pill tone="red">Grace · {daysUntil(row.billing.graceExpiresAt)}d left</Pill>;
  }
  if (row.readOnlyCount > 0) return <Pill tone="amber">Frozen ({row.readOnlyCount})</Pill>;
  if (row.billing.trialEndsAt && new Date(row.billing.trialEndsAt).getTime() > now) {
    const days = daysUntil(row.billing.trialEndsAt);
    return <Pill tone={days <= 3 ? "amber" : "blue"}>Trial · {days}d left</Pill>;
  }
  if (row.billing.hasSubscription) return <Pill tone="green">Paying</Pill>;
  if (row.tier !== "free") return <Pill tone="indigo">Manual {row.tier}</Pill>;
  return <Pill>Free</Pill>;
}

export function SubscriptionsView() {
  const searchParams = useSearchParams();
  const initial = searchParams.get("billing");
  const [billing, setBilling] = useState<BillingFilter>(
    isBillingFilter(initial) ? initial : "all",
  );
  const [tier, setTier] = useState("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);

  const overview = useAdminQuery<AdminOverview>("/api/v1/admin/overview");
  const list = useAdminList<TenantSummary>("/api/v1/admin/tenants", {
    billing: billing !== "all" && billing,
    tier: tier !== "all" && tier,
    q,
  });

  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Subscriptions"
        description="Billing state across every account. Trials and grace windows are shown as days left; Stripe identifiers never leave the server."
        actions={
          <RefreshButton
            onClick={() => {
              overview.reload();
              void list.reload();
            }}
            refreshing={list.status === "loading"}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Paying"
          value={o?.subscriptions.active ?? "—"}
          hint="Active Stripe subscription"
        />
        <StatTile
          label="Stripe customers"
          value={o?.subscriptions.withCustomer ?? "—"}
          hint="Have checked out at least once"
        />
        <StatTile label="In trial" value={o?.subscriptions.inTrial ?? "—"} />
        <StatTile
          label="In grace"
          value={o?.subscriptions.inGrace ?? "—"}
          tone={o && o.subscriptions.inGrace > 0 ? "critical" : "default"}
          hint="Payment failed — at risk"
        />
        <StatTile
          label="Premium + Enterprise"
          value={o ? o.tenants.byTier.premium + o.tenants.byTier.enterprise : "—"}
          hint={o ? `${o.tenants.byTier.free} on Free` : undefined}
        />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented
          label="Billing status"
          value={billing}
          options={BILLING_OPTIONS}
          onChange={setBilling}
        />
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search accounts"
            placeholder="Search by name or slug…"
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-background pl-8"
          />
        </div>
        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger aria-label="Filter by tier" className="bg-background lg:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            <SelectItem value="free">Free</SelectItem>
            <SelectItem value="premium">Premium</SelectItem>
            <SelectItem value="enterprise">Enterprise</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ListBody
        status={list.status}
        error={list.status === "error" ? list.error : undefined}
        count={list.rows.length}
        label="subscriptions"
        onRetry={() => void list.reload()}
        empty={{
          title: "No accounts match",
          description: "Nothing matches the current billing filter.",
        }}
      >
        <DataTable>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Tier</th>
              <th scope="col">Status</th>
              <th scope="col">Stripe</th>
              <th scope="col">Trial ends</th>
              <th scope="col">Grace ends</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link
                    href={`/admin/tenants/${row.id}`}
                    className="font-medium hover:text-graft-green-deep hover:underline dark:hover:text-graft-green-light"
                  >
                    {row.name || "(unnamed)"}
                  </Link>
                  <div className="font-mono text-xs text-muted-foreground">{row.slug}</div>
                </td>
                <td>
                  <TierPill tier={row.tier} />
                </td>
                <td>
                  <StatusPill row={row} />
                </td>
                <td className="text-xs">
                  {row.billing.hasSubscription ? (
                    "Subscription"
                  ) : row.billing.hasCustomer ? (
                    "Customer only"
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-muted-foreground">
                  {row.billing.trialEndsAt
                    ? new Date(row.billing.trialEndsAt).toLocaleDateString()
                    : "—"}
                </td>
                <td className="text-muted-foreground">
                  {row.billing.graceExpiresAt
                    ? new Date(row.billing.graceExpiresAt).toLocaleDateString()
                    : "—"}
                </td>
                <td className="text-muted-foreground">
                  <When iso={row.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ListBody>
      <LoadMore
        hasMore={list.hasMore}
        loading={list.loadingMore}
        onClick={() => void list.loadMore()}
        shown={list.rows.length}
      />
    </div>
  );
}
