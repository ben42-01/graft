"use client";

/**
 * `/admin/audit` — the platform-admin audit log. All behaviour lives in `AuditView`; this file wires the
 * Suspense boundary its `useSearchParams` read needs in the app router.
 */
import { Suspense } from "react";
import { AuditView } from "@/components/admin/audit-view";
import { LoadingState } from "@/components/shell/loading-state";

export default function AdminAuditViewPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" variant="page" />}>
      <AuditView />
    </Suspense>
  );
}
