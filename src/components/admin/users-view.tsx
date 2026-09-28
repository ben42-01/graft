"use client";

/**
 * `/admin/users` — every user account across every tenant
 * (`GET /api/v1/admin/users`): who they are, whether they verified, which
 * workspaces they belong to and in what role. `?tenantId=` and `?q=` in the
 * URL pre-fill the filters, so a tenant's detail page and the ⌘K palette can
 * deep-link here.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { SearchIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminList, useDebounced } from "./admin-api";
import {
  DataTable,
  IdChip,
  ListBody,
  LoadMore,
  PageHeader,
  Pill,
  RefreshButton,
  Segmented,
  When,
} from "./admin-ui";

/** Mirrors `AdminUser` (src/server/services/admin-users.ts). */
export type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  createdAt: string | null;
  memberships: {
    tenantId: string;
    tenantName: string | null;
    tenantSlug: string | null;
    roles: string[];
  }[];
};

const VERIFIED_OPTIONS = [
  { value: "all", label: "All" },
  { value: "true", label: "Verified" },
  { value: "false", label: "Unverified" },
] as const;

export function UsersView() {
  const searchParams = useSearchParams();
  const [tenantId, setTenantId] = useState(searchParams.get("tenantId") ?? "");
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [verified, setVerified] = useState<(typeof VERIFIED_OPTIONS)[number]["value"]>("all");
  const [role, setRole] = useState("all");
  const [adminsOnly, setAdminsOnly] = useState(false);
  const q = useDebounced(search);

  const list = useAdminList<AdminUser>("/api/v1/admin/users", {
    q,
    tenantId,
    verified: verified !== "all" && verified,
    role: role !== "all" && role,
    platformAdmin: adminsOnly && "true",
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Every person with an account, across every workspace. Search by email or name."
        actions={
          <RefreshButton
            onClick={() => void list.reload()}
            refreshing={list.status === "loading"}
          />
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search users"
            placeholder="Search by email or name…"
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-background pl-8"
          />
        </div>
        <Segmented
          label="Verification"
          value={verified}
          options={VERIFIED_OPTIONS}
          onChange={setVerified}
        />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger aria-label="Filter by role" className="bg-background lg:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any role</SelectItem>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="member">Member</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={adminsOnly ? "default" : "outline"}
          size="sm"
          aria-pressed={adminsOnly}
          onClick={() => setAdminsOnly((v) => !v)}
        >
          <ShieldCheckIcon aria-hidden="true" />
          Platform admins
        </Button>
      </div>

      {tenantId ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          Members of account <span className="font-mono">{tenantId}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear account filter"
            onClick={() => setTenantId("")}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}

      <ListBody
        status={list.status}
        error={list.status === "error" ? list.error : undefined}
        count={list.rows.length}
        label="users"
        onRetry={() => void list.reload()}
        empty={{
          title: "No users match",
          description: q ? `Nothing matches “${q}”.` : "No users for this filter.",
        }}
      >
        <DataTable>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Workspaces</th>
              <th scope="col">Status</th>
              <th scope="col">Joined</th>
              <th scope="col">Id</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-graft-green/10 text-xs font-semibold text-graft-green-deep uppercase dark:text-graft-green-light">
                      {(user.name || user.email).charAt(0)}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{user.email}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {user.name ?? "—"}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    {user.memberships.length === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : null}
                    {user.memberships.map((m) => (
                      <Link
                        key={m.tenantId}
                        href={`/admin/tenants/${m.tenantId}`}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs hover:border-graft-green/50"
                      >
                        {m.tenantName ?? m.tenantSlug ?? m.tenantId.slice(-6)}
                        {m.roles.length > 0 ? (
                          <span className="text-muted-foreground">· {m.roles.join(", ")}</span>
                        ) : null}
                      </Link>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {user.emailVerified ? (
                      <Pill tone="green">Verified</Pill>
                    ) : (
                      <Pill tone="amber">Unverified</Pill>
                    )}
                    {user.isPlatformAdmin ? <Pill tone="indigo">Platform admin</Pill> : null}
                  </div>
                </td>
                <td className="text-muted-foreground">
                  <When iso={user.createdAt} />
                </td>
                <td>
                  <IdChip id={user.id} />
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
