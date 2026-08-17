"use client";

/**
 * The client's one read of `GET /api/v1/me` (GRAFT-11.4 AC1). The shape here
 * mirrors `MeView` (src/server/services/accounts.ts) but is declared
 * independently so this "use client" file never imports server-only code.
 * Renders what `/me` decided to report — never decides entitlement itself.
 * A fetch failure resolves to "unauthenticated" — the same safe default as a
 * 401 — since a dedicated error state is GRAFT-11.5's scope, not this one's.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type MembershipView = { tenantId: string; slug: string; name: string; roles: string[] };
export type TenantBrandingView = { logoUrl: string | null; primaryColor: string | null };

export type MeResponse = {
  user: { id: string; email: string; name: string | null; emailVerifiedAt: string | null };
  memberships: MembershipView[];
  tenant: {
    id: string;
    name: string;
    slug: string;
    tier: string;
    limits: Record<string, unknown>;
    branding: TenantBrandingView | null;
  };
};

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export type UseMeResult = {
  status: SessionStatus;
  me: MeResponse | null;
  /** POSTs the new active tenant, then re-fetches `/me` (AC1 — "re-fetches the session"). */
  switchTenant: (tenantId: string) => Promise<void>;
  logOut: () => Promise<void>;
};

async function readMe(): Promise<MeResponse | null> {
  try {
    const response = await fetch("/api/v1/me", { credentials: "include" });
    if (!response.ok) return null;
    return ((await response.json()) as { data: MeResponse }).data;
  } catch {
    return null;
  }
}

export function useMe(): UseMeResult {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    const result = await readMe();
    if (!mountedRef.current) return;
    setMe(result);
    setStatus(result ? "authenticated" : "unauthenticated");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const switchTenant = useCallback(
    async (tenantId: string) => {
      const response = await fetch("/api/v1/auth/switch-tenant", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (!response.ok) throw new Error("Could not switch workspace.");
      await load();
    },
    [load],
  );

  const logOut = useCallback(async () => {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
    setMe(null);
    setStatus("unauthenticated");
  }, []);

  return { status, me, switchTenant, logOut };
}
