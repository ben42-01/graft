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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";

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
    const body = (await response.json().catch(() => null)) as
      { data: unknown } | { error: { message: string } } | null;
    if (!response.ok || !body || "error" in body) {
      const message = body && "error" in body ? body.error.message : "Something went wrong.";
      return { ok: false, message };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
}

export default function SignupPage() {
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
      router.replace("/");
    }
  }, [status, router]);

  if (status === "authenticated") {
    return <LoadingState label="Redirecting…" />;
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to <span className="font-medium">{email}</span>. Follow
            it to activate your account, then log in.
          </p>
        </CardContent>
        <CardFooter>
          <a href="/login" className="text-sm text-primary underline-offset-4 hover:underline">
            Back to log in
          </a>
        </CardFooter>
      </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Sign up</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signup-business">Business name</Label>
            <Input
              id="signup-business"
              autoComplete="organization"
              required
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
            <Input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" data-testid="form-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Signing up…" : "Sign up"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/login" className="text-primary underline-offset-4 hover:underline">
              Log in
            </a>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
