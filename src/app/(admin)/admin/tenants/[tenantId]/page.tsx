/**
 * `/admin/tenants/[tenantId]` — the detail screen (AC7, AC8). All the
 * behaviour lives in `TenantDetail`; this file is just the route.
 */
import { TenantDetail } from "@/components/admin/tenant-detail";

export default async function AdminTenantDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  return <TenantDetail tenantId={tenantId} />;
}
