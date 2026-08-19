"use client";

/**
 * The auth-redirect guard (AC4): renders `LoadingState` (GRAFT-11.5 AC1)
 * while `/me` is loading — SSR emits the same shell-free markup, so there's
 * no authenticated chrome to flash before hydration — redirects to `/login`
 * on "unauthenticated", and only then mounts `AppShell`. The one place
 * `useMe()` is called for this section.
 *
 * GRAFT-18 AC1: the redirect carries the path the visitor actually wanted, so
 * `/login` can send them back there after a successful sign-in instead of
 * always landing on `/`.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";

export function SessionGate({ children }: { children: ReactNode }) {
  const { status, me, switchTenant, logOut } = useMe();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unauthenticated") {
      const target = pathname ? `/login?redirect=${encodeURIComponent(pathname)}` : "/login";
      router.replace(target);
    }
  }, [status, router, pathname]);

  if (status === "loading") {
    return <LoadingState label="Loading your workspace…" />;
  }

  if (status !== "authenticated" || !me) {
    return null;
  }

  return (
    <AppShell me={me} onSwitchTenant={switchTenant} onLogOut={logOut}>
      {children}
    </AppShell>
  );
}
