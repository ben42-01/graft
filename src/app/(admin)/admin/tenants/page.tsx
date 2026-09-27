/**
 * `/admin/tenants` — "Accounts" in the sidebar: every tenant workspace (AC1,
 * AC5, AC6). All the behaviour lives in `TenantTable`; `AdminStatsWidgets` is
 * the ad hoc tier summary over `GET /api/v1/admin/stats` above it.
 */
import { PageHeader } from "@/components/admin/admin-ui";
import { AdminStatsWidgets } from "@/components/admin/stats-widgets";
import { TenantTable } from "@/components/admin/tenant-table";

export default function AdminTenantsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Accounts"
        description="Every tenant workspace on the platform. Open one for its limits, members, entities, activity and the tier override."
      />
      <AdminStatsWidgets />
      <TenantTable />
    </div>
  );
}
