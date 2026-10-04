"use client";

/**
 * "Send me a new link" for an account whose verification email never arrived,
 * expired or was already spent. Calls POST /api/v1/auth/resend-verification,
 * which answers the same way for every address — so the confirmation here is
 * deliberately conditional ("if that account still needs confirming") and
 * never says whether the account exists.
 *
 * With `email` it is one button (signup's "check your email", login's
 * "verify first"); without, it asks for the address (a dead verification link).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api-error";

type State = "idle" | "sending" | "sent";

export function ResendVerification({ email: knownEmail }: { email?: string }) {
  const [email, setEmail] = useState(knownEmail ?? "");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setState("sending");
    setError(null);
    try {
      const response = await fetch("/api/v1/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (response.ok) {
        setState("sent");
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      setError(errorMessage(body, { email: "Email" }));
    } catch {
      setError("Network error. Try again.");
    }
    setState("idle");
  }

  if (state === "sent") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        If that account still needs confirming, a new link is on its way. Check your spam folder
        too — it can take a minute to arrive.
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void resend();
      }}
    >
      {knownEmail ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="resend-email">Email</Label>
          <Input
            id="resend-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
      )}
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="self-start"
        loading={state === "sending"}
      >
        Resend verification email
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
