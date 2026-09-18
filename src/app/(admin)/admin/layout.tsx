"use client";

/**
 * The platform-admin console's own gate (GRAFT-27.3).
 *
 * This is a **separate route group** from `src/app/(app)/layout.tsx` on
 * purpose, not a variant of it. The tenant app's layout mounts `SessionGate`
 * -> `AppShell`, which renders tenant chrome — nav, `TenantSwitcher`, tier
 * badges, upgrade prompts — none of which means anything for the platform
 * owner looking across every tenant. Reusing it would mean this console
 * silently inherits every future tenant-shell change. So this layout does not
 * import `AppShell`, `TenantSwitcher`, or `useMe` (AC9) — asserted directly by
 * layout.test.tsx by reading this file's own source, so the two shells cannot
 * quietly converge later without the test noticing.
 *
 * The gate below is convenience only. Every fact this console renders is
 * already enforced server-side by `assertPlatformAdmin`
 * (src/server/auth/platform-admin.ts) on every `/api/v1/admin/*` route. A
 * client gate that was the *security* boundary would be no boundary at all —
 * this one only decides what a browser shows while the probe is in flight or
 * refused; it fetches no tenant data itself and never bypasses the caller's
 * own session (no service-role reads, no server-component shortcut).
 *
 * - AC2 — a signed-in non-admin's probe 404s (`useAdminSession` -> "not-admin")
 *   and is sent to `/`, with nothing admin-shaped ever rendered, loading
 *   included.
 * - AC3 — a visitor with no session at all gets 401 ("unauthenticated") and is
 *   sent to `/login?redirect=...`, reusing the GRAFT-18 safe-redirect pattern.
 * - AC4 — while the probe is in flight, only `LoadingState` renders; there is
 *   no server-rendered tenant data because nothing here reads any tenant data
 *   at all — that's `TenantTable` / `TenantDetail`'s job, both mounted only
 *   once `status === "authenticated"`.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { LoadingState } from "@/components/shell/loading-state";
import { useAdminSession } from "@/lib/admin-session";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { status } = useAdminSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unauthenticated") {
      const target = pathname ? `/login?redirect=${encodeURIComponent(pathname)}` : "/login";
      router.replace(target);
      return;
    }
    if (status === "not-admin") {
      // No detail beyond the bare redirect — see the module docs: a 404 from
      // the probe must never grow a "you are not an admin" moment on screen.
      router.replace("/");
    }
  }, [status, router, pathname]);

  if (status === "loading") {
    return <LoadingState label="Loading…" />;
  }

  if (status !== "authenticated") {
    return null;
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex items-center justify-between border-b border-border pb-4">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Platform admin
        </p>
      </header>
      <ErrorBoundary>{children}</ErrorBoundary>
    </div>
  );
}
