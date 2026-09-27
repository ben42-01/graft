"use client";

/**
 * The right-hand column of a tenant's detail screen: who is in the workspace,
 * what they have built, and what happened recently — each a short read of the
 * matching cross-tenant list narrowed by `tenantId`, with a link to the full
 * screen. Independent of the contract sections on the left: if one of these
 * reads fails, it says so in its own panel and the rest of the page is intact.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { useAdminQuery } from "./admin-api";
import type { ActivityRow } from "./activity-monitor";
import type { AdminEntity } from "./entities-view";
import { formatNumber, OutcomePill, Pill, When } from "./admin-ui";
import type { AdminUser } from "./users-view";

function SidePanel<T>({
  title,
  href,
  query,
  empty,
  render,
}: {
  title: string;
  href: string;
  query: { status: string; data: T[] | null };
  empty: string;
  render: (row: T) => ReactNode;
}) {
  // An unexpected payload is treated as a failed read, never rendered.
  const rows = Array.isArray(query.data) ? query.data : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link
          href={href}
          className="text-xs font-medium text-graft-green-deep hover:underline dark:text-graft-green-light"
        >
          View all
        </Link>
      </div>
      {rows ? (
        rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">{rows.map(render)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">{empty}</p>
        )
      ) : query.status === "error" ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load this.</p>
      ) : (
        <div className="h-16 animate-pulse rounded-md bg-muted" />
      )}
    </div>
  );
}

export function TenantSidePanels({ tenantId }: { tenantId: string }) {
  const members = useAdminQuery<AdminUser[]>("/api/v1/admin/users", { tenantId, limit: "8" });
  const entities = useAdminQuery<AdminEntity[]>("/api/v1/admin/entities", {
    tenantId,
    limit: "8",
  });
  const activity = useAdminQuery<ActivityRow[]>("/api/v1/admin/activities", {
    tenantId,
    limit: "6",
  });

  return (
    <div className="flex flex-col gap-4">
      <SidePanel
        title="Members"
        href={`/admin/users?tenantId=${tenantId}`}
        query={members}
        empty="No members."
        render={(user) => {
          const roles = user.memberships.find((m) => m.tenantId === tenantId)?.roles ?? [];
          return (
            <li key={user.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{user.email}</span>
              {roles.map((role) => (
                <Pill key={role} tone={role === "owner" ? "green" : "neutral"}>
                  {role}
                </Pill>
              ))}
              {!user.emailVerified ? <Pill tone="amber">unverified</Pill> : null}
            </li>
          );
        }}
      />
      <SidePanel
        title="Entities"
        href={`/admin/entities?tenantId=${tenantId}`}
        query={entities}
        empty="Nothing built yet."
        render={(entity) => (
          <li key={entity.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {entity.name}
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {entity.key}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">{entity.fields.length} fields</span>
            <span className="w-16 text-right font-medium tabular-nums">
              {formatNumber(entity.recordCount)}
            </span>
          </li>
        )}
      />
      <SidePanel
        title="Recent activity"
        href={`/admin/activities?tenantId=${tenantId}`}
        query={activity}
        empty="No activity recorded."
        render={(row) => (
          <li key={row.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.action}</span>
            <OutcomePill ok={row.ok} />
            <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
              <When iso={row.at} />
            </span>
          </li>
        )}
      />
    </div>
  );
}
