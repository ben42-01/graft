/**
 * `/admin/tenants` — the list screen (AC1, AC5, AC6). All the behaviour lives
 * in `TenantTable`; this file is just the route. `AdminStatsWidgets` is a
 * separate, ad hoc addition (not part of the GRAFT-27 contract) — a summary
 * strip over `GET /api/v1/admin/stats`, independent of the table below it.
 */
import { AdminStatsWidgets } from "@/components/admin/stats-widgets";
import { TenantTable } from "@/components/admin/tenant-table";

export default function AdminTenantsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Tenants</h1>
        <AdminStatsWidgets />
      </div>
      <TenantTable />
    </div>
  );
}
