"use client";

/**
 * The auth-redirect guard (AC4): renders nothing while `/me` is loading — SSR
 * emits the same nothing, so there's no authenticated chrome to flash before
 * hydration — redirects to `/login` on "unauthenticated", and only then
 * mounts `AppShell`. The one place `useMe()` is called for this section.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { useMe } from "@/lib/session";

export function SessionGate({ children }: { children: ReactNode }) {
  const { status, me, switchTenant, logOut } = useMe();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  if (status !== "authenticated" || !me) {
    return null;
  }

  return (
    <AppShell me={me} onSwitchTenant={switchTenant} onLogOut={logOut}>
      {children}
    </AppShell>
  );
}
