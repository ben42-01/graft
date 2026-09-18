"use client";

/**
 * The client's one read of `GET /api/v1/admin/session` (GRAFT-27.3 AC2-AC4).
 *
 * Deliberately self-contained: it does not import `@/lib/session` (`useMe`)
 * even though the two hooks look similar, because the admin layout that uses
 * this file must never import `useMe` (AC9) — the two shells are not variants
 * of one another, and a shared import would be exactly the seam that lets
 * them quietly converge. The small duplication of the refresh call below is
 * the price of that, and it is a low one.
 *
 * This is convenience only. Every fact the admin console renders is already
 * enforced server-side by `assertPlatformAdmin` on every admin route; this
 * hook decides what the *client* shows while loading or refused, never what
 * the server allows.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Mirrors `PlatformAdminActor` (src/server/auth/platform-admin.ts). */
export type AdminActor = Readonly<{
  userId: string;
  email: string;
  isPlatformAdmin: true;
}>;

export type AdminSessionStatus = "loading" | "authenticated" | "unauthenticated" | "not-admin";

export type UseAdminSessionResult = {
  status: AdminSessionStatus;
  actor: AdminActor | null;
};

type ProbeResult = { ok: true; actor: AdminActor } | { ok: false; status: number };

async function probe(): Promise<ProbeResult> {
  try {
    const response = await fetch("/api/v1/admin/session", { credentials: "include" });
    if (response.ok) {
      const body = (await response.json()) as { data: AdminActor };
      return { ok: true, actor: body.data };
    }
    return { ok: false, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Rotates the session via the httpOnly refresh cookie — same mechanism
 * `useMe` uses, duplicated rather than imported (see module docs above). */
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

function statusFor(result: ProbeResult): {
  status: AdminSessionStatus;
  actor: AdminActor | null;
} {
  if (result.ok) return { status: "authenticated", actor: result.actor };
  // 404 is the platform-admin gate's own refusal (AC2) — never 403, so it is
  // indistinguishable from "this route doesn't exist" to anyone who isn't one.
  if (result.status === 404) return { status: "not-admin", actor: null };
  return { status: "unauthenticated", actor: null };
}

async function readAdminSession(): Promise<{
  status: AdminSessionStatus;
  actor: AdminActor | null;
}> {
  const first = await probe();
  if (first.ok) return statusFor(first);
  // A 401 here is most often the 15-minute access token having expired
  // mid-session (see `useMe`'s identical comment); anything else — 404 in
  // particular — is a real answer and is never retried.
  if (first.status !== 401) return statusFor(first);
  if (!(await refreshSession())) return { status: "unauthenticated", actor: null };
  return statusFor(await probe());
}

export function useAdminSession(): UseAdminSessionResult {
  const [status, setStatus] = useState<AdminSessionStatus>("loading");
  const [actor, setActor] = useState<AdminActor | null>(null);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    const result = await readAdminSession();
    if (!mountedRef.current) return;
    setActor(result.actor);
    setStatus(result.status);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  return { status, actor };
}
