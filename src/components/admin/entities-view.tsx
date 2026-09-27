"use client";

/**
 * `/admin/entities` — what tenants have built: every entity definition across
 * every account, its field schema and how many live records fill it
 * (`GET /api/v1/admin/entities`). Schema metadata only — record contents are
 * never fetched. `?tenantId=` pre-fills the account filter.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminList, useDebounced } from "./admin-api";
import {
  DataTable,
  formatNumber,
  ListBody,
  LoadMore,
  PageHeader,
  Pill,
  RefreshButton,
  Segmented,
  When,
} from "./admin-ui";

/** Mirrors `AdminEntity` (src/server/services/admin-entities.ts). */
export type AdminEntity = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  key: string;
  name: string;
  fields: { key: string; label: string; type: string; required: boolean }[];
  schemaVersion: number;
  recordCount: number;
  deleted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

const DELETED_OPTIONS = [
  { value: "exclude", label: "Live" },
  { value: "only", label: "Deleted" },
  { value: "include", label: "All" },
] as const;

export function EntitiesView() {
  const searchParams = useSearchParams();
  const [tenantId, setTenantId] = useState(searchParams.get("tenantId") ?? "");
  const [search, setSearch] = useState("");
  const [deleted, setDeleted] = useState<(typeof DELETED_OPTIONS)[number]["value"]>("exclude");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useDebounced(search);

  const list = useAdminList<AdminEntity>("/api/v1/admin/entities", { q, tenantId, deleted });

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Entities"
        description="Every data shape tenants have defined, with its fields and how many records fill it. Expand a row for the schema."
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
            aria-label="Search entities"
            placeholder="Search by name or key…"
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-background pl-8"
          />
        </div>
        <Segmented
          label="Deleted"
          value={deleted}
          options={DELETED_OPTIONS}
          onChange={setDeleted}
        />
      </div>

      {tenantId ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          Entities of account <span className="font-mono">{tenantId}</span>
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
        label="entities"
        onRetry={() => void list.reload()}
        empty={{
          title: "No entities match",
          description: "No tenant has defined an entity for this filter.",
        }}
      >
        <DataTable>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Expand</span>
              </th>
              <th scope="col">Entity</th>
              <th scope="col">Account</th>
              <th scope="col">Fields</th>
              <th scope="col" className="text-right">
                Records
              </th>
              <th scope="col">Version</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((entity) => {
              const isOpen = open.has(entity.id);
              return (
                <Fragment key={entity.id}>
                  <tr>
                    <td className="w-8">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Hide fields" : "Show fields"}
                        onClick={() => toggle(entity.id)}
                      >
                        {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                      </Button>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 font-medium">
                        {entity.name || "(unnamed)"}
                        {entity.deleted ? <Pill tone="red">Deleted</Pill> : null}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {entity.key}
                      </div>
                    </td>
                    <td>
                      <Link
                        href={`/admin/tenants/${entity.tenantId}`}
                        className="hover:text-graft-green-deep hover:underline dark:hover:text-graft-green-light"
                      >
                        {entity.tenantName ?? entity.tenantSlug ?? entity.tenantId.slice(-8)}
                      </Link>
                    </td>
                    <td className="text-muted-foreground">{entity.fields.length}</td>
                    <td className="text-right font-medium tabular-nums">
                      {formatNumber(entity.recordCount)}
                    </td>
                    <td className="text-muted-foreground">v{entity.schemaVersion}</td>
                    <td className="text-muted-foreground">
                      <When iso={entity.updatedAt} />
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-muted/30">
                      <td />
                      <td colSpan={6}>
                        <ul className="flex flex-wrap gap-1.5 py-1">
                          {entity.fields.map((field) => (
                            <li
                              key={field.key}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs"
                            >
                              <span className="font-medium">{field.label}</span>
                              <span className="font-mono text-muted-foreground">
                                {field.key}
                              </span>
                              <Pill tone="blue">{field.type}</Pill>
                              {field.required ? <Pill tone="amber">required</Pill> : null}
                            </li>
                          ))}
                        </ul>
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
        hasMore={list.hasMore}
        loading={list.loadingMore}
        onClick={() => void list.loadMore()}
        shown={list.rows.length}
      />
    </div>
  );
}
