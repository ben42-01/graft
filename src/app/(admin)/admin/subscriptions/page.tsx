"use client";

/**
 * `/admin/subscriptions` — billing state across every account. All behaviour lives in `SubscriptionsView`; this file wires the
 * Suspense boundary its `useSearchParams` read needs in the app router.
 */
import { Suspense } from "react";
import { SubscriptionsView } from "@/components/admin/subscriptions-view";
import { LoadingState } from "@/components/shell/loading-state";

export default function AdminSubscriptionsViewPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" variant="page" />}>
      <SubscriptionsView />
    </Suspense>
  );
}
