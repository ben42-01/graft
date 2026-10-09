"use client";

/**
 * `/device` — where a person approves a `graft login` from the CLI
 * (src/server/services/device-auth.ts).
 *
 * Three steps: type the code shown in the terminal → see which machine is
 * asking and pick the workspace → approve or deny. The code is always typed,
 * never taken from the URL: a link that pre-fills it is how device-code
 * phishing works ("click here and press Approve"), and typing it from your own
 * terminal is what proves the terminal is yours.
 *
 * Under (public), not (app): a logged-out visitor gets a "Log in" button that
 * comes back here, rather than the app shell's generic redirect.
 */
import { useState } from "react";
import Link from "next/link";
import { AuthShell } from "@/components/brand/auth-shell";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingState } from "@/components/shell/loading-state";
import { errorMessage, isApiError } from "@/lib/api-error";
import { useMe } from "@/lib/session";

type Client = {
  name: string;
  hostname: string | null;
  platform: string | null;
  version: string | null;
};
type Pending = { userCode: string; client: Client; requestedAt: string; expiresAt: string };
type Step =
  | { kind: "enter" }
  | { kind: "confirm"; pending: Pending }
  | { kind: "done"; approved: boolean };

async function post<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok || !json || isApiError(json))
      return { ok: false, message: errorMessage(json) };
    return { ok: true, data: (json as { data: T }).data };
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
}

/** "BCDFGHJK" as typed → "BCDF-GHJK" as shown, without fighting the cursor. */
function formatCode(raw: string): string {
  const letters = raw
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

function minutesAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return minutes === 0 ? "just now" : `${minutes} min ago`;
}

export function DeviceApproval() {
  const { status, me, switchTenant } = useMe();
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [code, setCode] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "loading") return <LoadingState label="Loading…" />;

  if (status !== "authenticated" || !me) {
    return (
      <AuthShell
        title="Sign in the Graft CLI"
        description="Log in to approve the request from your terminal."
      >
        <CardFooter className="flex flex-col gap-3">
          <Button asChild className="w-full">
            <Link href="/login?redirect=%2Fdevice">Log in</Link>
          </Button>
        </CardFooter>
      </AuthShell>
    );
  }

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await post<Pending>("/api/v1/auth/device/lookup", { userCode: code });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setTenantId(me.tenant.id);
    setStep({ kind: "confirm", pending: result.data });
  };

  const decide = async (pending: Pending, decision: "approve" | "deny") => {
    setError(null);
    setBusy(true);
    try {
      // Approval binds the CLI to the *current* workspace, so switch first.
      if (decision === "approve" && tenantId && tenantId !== me.tenant.id)
        await switchTenant(tenantId);
      const result = await post<{ status: string }>("/api/v1/auth/device/decision", {
        userCode: pending.userCode,
        decision,
      });
      if (!result.ok) return setError(result.message);
      setStep({ kind: "done", approved: decision === "approve" });
    } finally {
      setBusy(false);
    }
  };

  if (step.kind === "done") {
    return (
      <AuthShell title={step.approved ? "CLI signed in" : "Request denied"}>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {step.approved
              ? "Go back to your terminal — the CLI picks this up within a few seconds. You can close this tab."
              : "Nothing was signed in. If you didn't start this request, someone may have sent you a code: you can ignore it."}
          </p>
        </CardContent>
      </AuthShell>
    );
  }

  if (step.kind === "enter") {
    return (
      <AuthShell
        title="Sign in the Graft CLI"
        description="Enter the code your terminal is showing."
      >
        <form onSubmit={(e) => void lookup(e)}>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-code">Code</Label>
              <Input
                id="device-code"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                className="text-center font-mono text-lg tracking-widest uppercase"
                value={code}
                onChange={(e) => setCode(formatCode(e.target.value))}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </CardContent>
          <CardFooter className="mt-6">
            <Button
              type="submit"
              className="w-full"
              loading={busy}
              disabled={code.length !== 9}
            >
              Continue
            </Button>
          </CardFooter>
        </form>
      </AuthShell>
    );
  }

  const { pending } = step;
  const machine = [pending.client.hostname, pending.client.platform]
    .filter(Boolean)
    .join(" · ");
  return (
    <AuthShell title="Approve this sign-in?">
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Code</dt>
          <dd className="font-mono">{pending.userCode}</dd>
          <dt className="text-muted-foreground">Client</dt>
          <dd>
            {pending.client.name}
            {pending.client.version ? ` ${pending.client.version}` : ""}
          </dd>
          {machine ? (
            <>
              <dt className="text-muted-foreground">Machine</dt>
              <dd>{machine}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Requested</dt>
          <dd>{minutesAgo(pending.requestedAt)}</dd>
          <dt className="text-muted-foreground">Account</dt>
          <dd className="truncate">{me.user.email}</dd>
        </dl>

        {me.memberships.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-workspace">Workspace</Label>
            <Select value={tenantId ?? me.tenant.id} onValueChange={setTenantId}>
              <SelectTrigger id="device-workspace" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {me.memberships.map((m) => (
                  <SelectItem key={m.tenantId} value={m.tenantId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p>
            Workspace: <span className="font-medium">{me.tenant.name}</span>
          </p>
        )}

        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">
          Only approve if <strong>you</strong> just ran <code>graft login</code> and this code
          matches your terminal. The CLI will be able to do anything you can do in this
          workspace. Never approve a code someone else sent you.
        </p>
        <p className="text-xs text-muted-foreground">
          Client and machine are what the CLI reports about itself.
        </p>

        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="mt-6 flex gap-3">
        <Button
          variant="outline"
          className="flex-1"
          disabled={busy}
          onClick={() => void decide(pending, "deny")}
        >
          Deny
        </Button>
        <Button
          className="flex-1"
          loading={busy}
          onClick={() => void decide(pending, "approve")}
        >
          Approve
        </Button>
      </CardFooter>
    </AuthShell>
  );
}
