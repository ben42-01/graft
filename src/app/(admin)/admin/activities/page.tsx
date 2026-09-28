"use client";

/**
 * `/admin/activities` — the Activity Monitor (supersedes the GRAFT-29.3 table). All behaviour lives in `ActivityMonitor`; this file wires the
 * Suspense boundary its `useSearchParams` read needs in the app router.
 */
import { Suspense } from "react";
import { ActivityMonitor } from "@/components/admin/activity-monitor";
import { LoadingState } from "@/components/shell/loading-state";

export default function AdminActivityMonitorPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" variant="page" />}>
      <ActivityMonitor />
    </Suspense>
  );
}
