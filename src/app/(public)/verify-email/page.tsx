"use client";

/**
 * `/verify-email?token=…` — where the verification email's button lands. It
 * spends the token against `POST /api/v1/auth/verify-email` (a protected route
 * this page only calls) and sends the person on to log in.
 *
 * The POST runs once per page load, guarded by a ref: the token is single-use,
 * so React's development double-effect would otherwise spend it on the first
 * run and report the second as an invalid link.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthShell } from "@/components/brand/auth-shell";
import { ResendVerification } from "@/components/brand/resend-verification";
import { CardContent, CardFooter } from "@/components/ui/card";
import { LoadingState } from "@/components/shell/loading-state";
import { errorMessage } from "@/lib/api-error";

type State = { kind: "working" } | { kind: "done" } | { kind: "failed"; message: string };

const linkClass =
  "text-sm font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light";

function VerifyEmail() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>({ kind: "working" });
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (!token) {
      setState({ kind: "failed", message: "This link is missing its token." });
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/api/v1/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (response.ok) {
          setState({ kind: "done" });
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        setState({ kind: "failed", message: errorMessage(body, { token: "Link" }) });
      } catch {
        setState({ kind: "failed", message: "Network error. Reload the page to try again." });
      }
    })();
  }, [token]);

  if (state.kind === "working") return <LoadingState label="Confirming your email…" />;

  if (state.kind === "done") {
    return (
      <AuthShell title="Email confirmed">
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your account is active. Log in to get started.
          </p>
        </CardContent>
        <CardFooter className="mt-6">
          <a href="/login" className={linkClass}>
            Log in
          </a>
        </CardFooter>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="This link didn't work">
      <CardContent className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
        <p className="text-sm text-muted-foreground">
          Verification links work once and expire after 24 hours. If you already confirmed your
          email, just log in — otherwise ask for a new link.
        </p>
        <ResendVerification />
      </CardContent>
      <CardFooter className="mt-6">
        <a href="/login" className={linkClass}>
          Go to log in
        </a>
      </CardFooter>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <VerifyEmail />
    </Suspense>
  );
}
