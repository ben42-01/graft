"use client";

/**
 * `/admin/users` — every user account across every tenant. All behaviour lives in `UsersView`; this file wires the
 * Suspense boundary its `useSearchParams` read needs in the app router.
 */
import { Suspense } from "react";
import { UsersView } from "@/components/admin/users-view";
import { LoadingState } from "@/components/shell/loading-state";

export default function AdminUsersViewPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" variant="page" />}>
      <UsersView />
    </Suspense>
  );
}
