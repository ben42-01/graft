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
    /**
     * Resolved features — tier plus any per-tenant override. A gate renders
     * from this, never from `tier`. Optional only so older fixtures still
     * type-check; the server always sends it, and absent reads as "not included".
     */
    features?: Record<string, boolean>;
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

async function fetchMe(): Promise<MeResponse | null> {
  try {
    const response = await fetch("/api/v1/me", { credentials: "include" });
    if (!response.ok) return null;
    return ((await response.json()) as { data: MeResponse }).data;
  } catch {
    return null;
  }
}

/**
 * Rotates the session via the httpOnly refresh cookie. The access token lives
 * 15 minutes (tokens.ts `ACCESS_TTL_SECONDS`) and nothing here can read that
 * cookie to know when it's about to expire, so this is called both on a
 * schedule and reactively — see `useMe` below.
 */
async function refreshSession(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Well under the 15-minute access token TTL, so the proactive refresh below
 * wins the race against expiry under normal use. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

async function readMe(): Promise<MeResponse | null> {
  const result = await fetchMe();
  if (result) return result;
  // A 401 here is most often just the 15-minute access token having expired
  // mid-session, not an actual logout — the refresh cookie can still mint a
  // new one before this gives up and reports "unauthenticated".
  if (!(await refreshSession())) return null;
  return fetchMe();
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

  // Refreshes ahead of the access token's own expiry so an active user is
  // never the one who has to notice it lapsed.
  useEffect(() => {
    if (status !== "authenticated") return;
    const interval = setInterval(() => void refreshSession(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [status]);

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
