"use client";

/**
 * `/admin/activities` — the activity log console (GRAFT-29.3 AC1, AC4). All
 * the behaviour lives in `ActivityTable`; this file wires the `tenantId`
 * query param (AC4) and, like `/login` (src/app/(public)/login/page.tsx),
 * splits out the `useSearchParams` read into its own component because that
 * hook needs a Suspense boundary in the Next.js app router.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ActivityTable } from "@/components/admin/activity-table";
import { LoadingState } from "@/components/shell/loading-state";

function ActivitiesPageContent() {
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenantId") ?? "";
  return <ActivityTable initialTenantId={tenantId} />;
}

export default function AdminActivitiesPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Activity</h1>
      <Suspense fallback={<LoadingState label="Loading…" />}>
        <ActivitiesPageContent />
      </Suspense>
    </div>
  );
}
