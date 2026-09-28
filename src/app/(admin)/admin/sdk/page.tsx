"use client";

/**
 * `/admin/sdk` — the in-browser API client. All behaviour lives in `SdkExplorer`; this file wires the
 * Suspense boundary its `useSearchParams` read needs in the app router.
 */
import { Suspense } from "react";
import { SdkExplorer } from "@/components/admin/sdk-explorer";
import { LoadingState } from "@/components/shell/loading-state";

export default function AdminSdkExplorerPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" variant="page" />}>
      <SdkExplorer />
    </Suspense>
  );
}
