"use client";

/**
 * `/admin/audit` — the platform-admin audit log (`GET /api/v1/admin/audit`):
 * every action taken from this console, by whom, about which account, and for
 * a change, what it changed and why. Reads outnumber writes by orders of
 * magnitude, so "Changes only" is one click away. `?tenantId=` pre-fills.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminList } from "./admin-api";
import {
  CopyButton,
  DataTable,
  ListBody,
  LoadMore,
  OutcomePill,
  PageHeader,
  Pill,
  RefreshButton,
  Segmented,
  When,
} from "./admin-ui";

/** Mirrors `AdminAuditRow` (src/server/services/admin-audit-read.ts). */
type AuditRow = {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetTenantId: string | null;
  targetTenantName: string | null;
  requestId: string | null;
  at: string | null;
  details: {
    fromTier?: string;
    toTier?: string;
    reason?: string;
    changed?: boolean;
    ok?: boolean;
  };
};

const KIND_OPTIONS = [
  { value: "all", label: "Everything" },
  { value: "writes", label: "Changes only" },
] as const;

/** Prefixes of the stable `admin.*` verbs the routes write. */
const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "admin.tenant.", label: "Tier overrides" },
  { value: "admin.tenants", label: "Account reads" },
  { value: "admin.users", label: "User reads" },
  { value: "admin.entities", label: "Entity reads" },
  { value: "admin.activities", label: "Activity reads" },
  { value: "admin.overview", label: "Dashboard reads" },
  { value: "admin.audit", label: "Audit reads" },
  { value: "admin.session", label: "Console sign-ins" },
];

export function AuditView() {
  const searchParams = useSearchParams();
  const [tenantId, setTenantId] = useState(searchParams.get("tenantId") ?? "");
  const [kind, setKind] = useState<(typeof KIND_OPTIONS)[number]["value"]>("all");
  const [action, setAction] = useState("all");

  const list = useAdminList<AuditRow>("/api/v1/admin/audit", {
    tenantId,
    kind: kind !== "all" && kind,
    action: action !== "all" && action,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every action taken through the admin API — including reading this page. Append-only; nothing here can be edited or removed."
        actions={
          <RefreshButton
            onClick={() => void list.reload()}
            refreshing={list.status === "loading"}
          />
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger aria-label="Filter by action" className="bg-background sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tenantId ? (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            About account <span className="font-mono">{tenantId.slice(-8)}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Clear account filter"
              onClick={() => setTenantId("")}
            >
              <XIcon />
            </Button>
          </span>
        ) : null}
      </div>

      <ListBody
        status={list.status}
        error={list.status === "error" ? list.error : undefined}
        count={list.rows.length}
        label="audit log"
        onRetry={() => void list.reload()}
        empty={{
          title: "Nothing recorded",
          description: "No admin actions match this filter.",
        }}
      >
        <DataTable>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Admin</th>
              <th scope="col">Action</th>
              <th scope="col">Account</th>
              <th scope="col">Details</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.id}>
                <td className="text-muted-foreground">
                  <When iso={row.at} />
                </td>
                <td
                  className="max-w-48 truncate"
                  title={row.actorEmail ?? row.actorUserId ?? ""}
                >
                  {row.actorEmail ?? (
                    <span className="font-mono text-xs">
                      {row.actorUserId?.slice(-8) ?? "—"}
                    </span>
                  )}
                </td>
                <td className="font-mono text-xs">{row.action}</td>
                <td>
                  {row.targetTenantId ? (
                    <Link
                      href={`/admin/tenants/${row.targetTenantId}`}
                      className="hover:text-graft-green-deep hover:underline dark:hover:text-graft-green-light"
                    >
                      {row.targetTenantName ?? row.targetTenantId.slice(-8)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {row.details.fromTier || row.details.toTier ? (
                      <span className="font-medium capitalize">
                        {row.details.fromTier ?? "?"} → {row.details.toTier ?? "?"}
                      </span>
                    ) : null}
                    {row.details.changed === false ? <Pill>no-op</Pill> : null}
                    {row.details.ok !== undefined ? <OutcomePill ok={row.details.ok} /> : null}
                    {row.details.reason ? (
                      <span
                        className="max-w-64 truncate text-muted-foreground"
                        title={row.details.reason}
                      >
                        “{row.details.reason}”
                      </span>
                    ) : null}
                    {Object.keys(row.details).length === 0 ? (
                      <span className="text-muted-foreground">Read</span>
                    ) : null}
                  </div>
                </td>
                <td>
                  {row.requestId ? (
                    <span className="inline-flex items-center font-mono text-xs text-muted-foreground">
                      {row.requestId.slice(0, 8)}
                      <CopyButton value={row.requestId} label="Copy request id" />
                    </span>
                  ) : null}
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
