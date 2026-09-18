/**
 * `/admin/tenants` — the list screen (AC1, AC5, AC6). All the behaviour lives
 * in `TenantTable`; this file is just the route.
 */
import { TenantTable } from "@/components/admin/tenant-table";

export default function AdminTenantsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Tenants</h1>
      <TenantTable />
    </div>
  );
}
