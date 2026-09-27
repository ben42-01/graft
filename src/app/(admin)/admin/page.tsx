/**
 * `/admin` — the platform dashboard. This used to redirect to `/admin/tenants`
 * (GRAFT-27.3 AC1: the root should always land somewhere useful); with the
 * sidebar console it *is* that somewhere. All behaviour lives in
 * `AdminDashboard`; this file is just the route.
 */
import { AdminDashboard } from "@/components/admin/admin-dashboard";

export default function AdminIndexPage() {
  return <AdminDashboard />;
}
