"use client";

/**
 * `/admin/entities` — entity definitions across every tenant. All behaviour lives in `EntitiesView`; this file wires the
 * Suspense boundary its `useSearchParams` read needs in the app router.
 */
import { Suspense } from "react";
import { EntitiesView } from "@/components/admin/entities-view";
import { LoadingState } from "@/components/shell/loading-state";

export default function AdminEntitiesViewPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" variant="page" />}>
      <EntitiesView />
    </Suspense>
  );
}
