/**
 * `/admin` itself carries no screen of its own (AC1) — it exists only to
 * redirect to the one that does, so a bookmark or a typed root URL always
 * lands somewhere useful.
 */
import { redirect } from "next/navigation";

export default function AdminIndexPage() {
  redirect("/admin/tenants");
}
