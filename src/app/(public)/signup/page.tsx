"use client";

/**
 * GRAFT-18 `/signup` — AC4–AC6. Consumes the existing
 * `POST /api/v1/auth/signup` (`src/app/api/v1/auth/signup/route.ts`, a
 * protected path this issue only calls, never edits). Per that route's
 * contract, signup deliberately returns no session — the account is
 * unverified — so success here shows a static confirmation, never a
 * redirect into the app.
 *
 * Fields are exactly `signupSchema` (`src/server/services/accounts.ts`):
 * email, password, businessName. There is no `name` field on the API — the
 * created user's `name` is `null` until a profile-settings feature exists —
 * so this form doesn't collect one either, rather than send a field the
 * service silently drops.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/brand/auth-shell";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/shell/loading-state";
import { errorMessage, isApiError } from "@/lib/api-error";
import { useMe } from "@/lib/session";

/**
 * Mirrors `PASSWORD_MIN_LENGTH` in `src/server/auth/passwords.ts`, which is
 * the source of truth and stays so — the server rejects anything shorter
 * regardless of what this file says. It is duplicated rather than imported
 * because that module also imports `@node-rs/argon2`, a native addon that has
 * no business in a client bundle, and it sits under the protected path
 * `src/server/auth/**` so the constant cannot be split out into its own
 * module here. If the server minimum changes, change this too.
 */
const PASSWORD_MIN_LENGTH = 12;

/** Mirrors `signupSchema`'s `businessName` bound in
 * `src/server/services/accounts.ts`. Same caveat as above: the server is the
 * one that enforces it — this only spares the user a round trip that comes
 * back with zod's raw "String must contain at least 2 character(s)". */
const BUSINESS_NAME_MIN_LENGTH = 2;

/** Wire field names → the labels this form actually shows. */
const SIGNUP_FIELD_LABELS = {
  businessName: "Business name",
  email: "Email",
  password: "Password",
};

type SignupResult = { ok: true } | { ok: false; message: string };

async function signup(
  businessName: string,
  email: string,
  password: string,
): Promise<SignupResult> {
  try {
    const response = await fetch("/api/v1/auth/signup", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, email, password }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !body || isApiError(body)) {
      // The server's per-field reasons, not just its generic
      // "Invalid request body" — see src/lib/api-error.ts.
      return { ok: false, message: errorMessage(body, SIGNUP_FIELD_LABELS) };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
}

function SignupForm() {
  const router = useRouter();
  const { status } = useMe();

  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // AC6 — an already-authenticated visitor never sees the form.
  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/home");
    }
  }, [status, router]);

  if (status === "authenticated") {
    return <LoadingState label="Redirecting…" />;
  }

  if (done) {
    return (
      <AuthShell title="Check your email">
        <CardContent>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to <span className="font-medium">{email}</span>. Follow
            it to activate your account, then log in.
          </p>
        </CardContent>
        <CardFooter className="mt-6">
          <a
            href="/login"
            className="text-sm font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light"
          >
            Back to log in
          </a>
        </CardFooter>
      </AuthShell>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await signup(businessName, email, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDone(true);
  };

  return (
    <AuthShell
      title="Sign up"
      description="Create your workspace — free forever on one workspace, no card required."
    >
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signup-business">Business name</Label>
            <Input
              id="signup-business"
              autoComplete="organization"
              required
              minLength={BUSINESS_NAME_MIN_LENGTH}
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signup-email">Email</Label>
            <Input
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signup-password">Password</Label>
            <PasswordInput
              id="signup-password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least {PASSWORD_MIN_LENGTH} characters.
            </p>
          </div>
          {error ? (
            <p role="alert" data-testid="form-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Signing up…" : "Sign up"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <a
              href="/login"
              className="font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light"
            >
              Log in
            </a>
          </p>
        </CardFooter>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return <SignupForm />;
}
