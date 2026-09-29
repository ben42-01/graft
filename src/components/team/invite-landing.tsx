"use client";

/**
 * The invite landing page body (GRAFT-33.3): "Join <workspace> as <role>".
 * Reads the public lookup (`GET /api/v1/public/invites/:token`), and for a
 * signed-in visitor takes the seat with `POST /api/v1/team/invites/accept`,
 * then switches into that workspace. A logged-out visitor is sent to log in or
 * sign up with the token carried along. Every invalid link — unknown, expired,
 * revoked, used — is the same neutral message, as the server treats it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/brand/auth-shell";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { LoadingState } from "@/components/shell/loading-state";
import { errorMessage, isApiError } from "@/lib/api-error";
import { roleLabel } from "@/lib/role-labels";
import { useMe } from "@/lib/session";

type Preview = { workspaceName: string; role: string; email?: string };

const LINK_CLASS =
  "font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light";

export function InviteLanding({ token }: { token: string }) {
  const router = useRouter();
  const { status, switchTenant } = useMe();
  const [preview, setPreview] = useState<Preview | "invalid" | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/public/invites/${encodeURIComponent(token)}`);
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        setPreview(
          response.ok && body && !isApiError(body)
            ? (body as { data: Preview }).data
            : "invalid",
        );
      } catch {
        if (!cancelled) setPreview("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (preview === null || status === "loading") return <LoadingState label="Loading…" />;

  if (preview === "invalid") {
    return (
      <AuthShell title="Invite">
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This invite link isn&apos;t valid any more.
          </p>
        </CardContent>
      </AuthShell>
    );
  }

  const join = async () => {
    setError(null);
    setJoining(true);
    try {
      const response = await fetch("/api/v1/team/invites/accept", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || isApiError(body)) {
        setError(errorMessage(body));
        return;
      }
      await switchTenant((body as { data: { tenantId: string } }).data.tenantId);
      router.replace("/home");
    } catch {
      setError("Couldn't join. Try again.");
    } finally {
      setJoining(false);
    }
  };

  const title = `Join ${preview.workspaceName} as ${roleLabel(preview.role)}`;
  const here = `/invite/${encodeURIComponent(token)}`;

  return (
    <AuthShell title={title}>
      <CardContent>
        {status === "authenticated" ? (
          <p className="text-sm text-muted-foreground">
            You&apos;ll switch into this workspace as soon as you join.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Log in or create an account to accept this invite.
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="mt-6 flex flex-col gap-3">
        {status === "authenticated" ? (
          <Button className="w-full" loading={joining} onClick={() => void join()}>
            Join
          </Button>
        ) : (
          <>
            <Button asChild className="w-full">
              <Link href={`/login?redirect=${encodeURIComponent(here)}`}>Log in</Link>
            </Button>
            <p className="text-sm text-muted-foreground">
              New here?{" "}
              <Link href={`/signup?invite=${encodeURIComponent(token)}`} className={LINK_CLASS}>
                Create account
              </Link>
            </p>
          </>
        )}
      </CardFooter>
    </AuthShell>
  );
}
