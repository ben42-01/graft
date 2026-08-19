"use client";

/**
 * GRAFT-18 `/login` — AC1–AC3, AC6, AC7. Consumes the existing
 * `POST /api/v1/auth/login` (`src/app/api/v1/auth/login/route.ts`, a
 * protected path this issue only calls, never edits) and sets the session
 * cookies the response already carries.
 *
 * `useSearchParams` needs a Suspense boundary (Next.js app router), hence the
 * split between the page's default export and `LoginForm`.
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";
import { sanitizeRedirectTarget } from "@/lib/safe-redirect";

type LoginResult = { ok: true } | { ok: false; message: string };

async function login(email: string, password: string): Promise<LoginResult> {
  try {
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
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

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useMe();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const target = sanitizeRedirectTarget(searchParams.get("redirect"));

  // AC6 — an already-authenticated visitor never sees the form.
  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/");
    }
  }, [status, router]);

  if (status === "authenticated") {
    return <LoadingState label="Redirecting…" />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login(email, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(target);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
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
            {submitting ? "Logging in…" : "Log in"}
          </Button>
          <p className="text-sm text-muted-foreground">
            No account?{" "}
            <a href="/signup" className="text-primary underline-offset-4 hover:underline">
              Sign up
            </a>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <LoginForm />
    </Suspense>
  );
}
