"use client";

/**
 * The Team screen (GRAFT-33.3): the owner's view of seats, members and invite
 * links, on top of `GET/POST /api/v1/team*`. Display only — the server decides
 * who may do what, how many seats there are and whether a link still works;
 * this renders what it says and surfaces its refusals.
 *
 * A non-owner never triggers a team request: the role comes from `/me`, which
 * the page already has, so the owner-only message is shown before any fetch.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/shell/loading-state";
import { errorMessage, isApiError } from "@/lib/api-error";
import { roleLabel, roleLabels } from "@/lib/role-labels";
import type { MeResponse } from "@/lib/session";

type TeamMember = { userId: string; email: string; roles: string[]; isYou: boolean };
type TeamInvite = { id: string; role: string; email: string | null; expiresAt: string };
type Team = {
  members: TeamMember[];
  invites: TeamInvite[];
  seats: { used: number; limit: number | null };
};

const SEAT_EXPLANATION =
  "Every seat on your plan is taken. Remove someone or upgrade to invite more people.";

type Call<T> = { ok: true; data: T } | { ok: false; code: string | null; message: string };

async function call<T>(path: string, init?: RequestInit): Promise<Call<T>> {
  try {
    const response = await fetch(path, {
      credentials: "include",
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || isApiError(body)) {
      return {
        ok: false,
        code: isApiError(body) ? body.error.code : null,
        message: errorMessage(body, { email: "Email" }),
      };
    }
    return { ok: true, data: ((body as { data?: T } | null)?.data ?? null) as T };
  } catch {
    return { ok: false, code: null, message: "Network error. Try again." };
  }
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function SeatExplanation() {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm">
      <p data-testid="seat-explanation">{SEAT_EXPLANATION}</p>
      <Link
        href="/account"
        className="font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light"
      >
        Upgrade your plan
      </Link>
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onCreated,
  onSeatsFull,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onSeatsFull: () => void;
}) {
  const [role, setRole] = useState<"admin" | "member">("member");
  const [email, setEmail] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  /** The address the server emailed the link to, when it did. */
  const [emailedTo, setEmailedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  // A fresh dialog each time it opens — never yesterday's link.
  useEffect(() => {
    if (!open) return;
    setRole("member");
    setEmail("");
    setUrl(null);
    setEmailedTo(null);
    setError(null);
    setCopied(false);
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await call<{ url: string; emailed?: boolean; invite: TeamInvite }>(
      "/api/v1/team/invites",
      {
        method: "POST",
        body: JSON.stringify({ role, ...(email.trim() ? { email: email.trim() } : {}) }),
      },
    );
    setSubmitting(false);
    if (result.ok) {
      setUrl(result.data.url);
      setEmailedTo(result.data.emailed ? result.data.invite.email : null);
      onCreated();
    } else if (result.code === "QUOTA_EXCEEDED") {
      onOpenChange(false);
      onSeatsFull();
    } else {
      setError(result.message);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="invite-description">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription id="invite-description">
            Add their email and we&apos;ll send them the link, or create one to share yourself.
          </DialogDescription>
        </DialogHeader>
        {url ? (
          <div className="flex flex-col gap-3">
            {emailedTo ? (
              <p className="text-sm">
                We emailed the invite to <span className="font-medium">{emailedTo}</span>. You
                can also copy the link below.
              </p>
            ) : null}
            <Label htmlFor="invite-link">Invite link</Label>
            <div className="flex gap-2">
              <Input id="invite-link" readOnly value={url} onFocus={(e) => e.target.select()} />
              <Button type="button" variant="outline" onClick={() => void copy()}>
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This link works once and expires in 7 days.
            </p>
          </div>
        ) : (
          <form id="invite-form" onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as "admin" | "member")}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="member">{roleLabel("member")}</option>
                <option value="admin">{roleLabel("admin")}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email (optional)</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                If you add one, we email them the link and only that address can use it.
              </p>
            </div>
          </form>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {copied ? "Link copied" : ""}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {url ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <Button type="submit" form="invite-form" loading={submitting}>
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pending = { kind: "invite" | "member"; id: string; label: string };

function ConfirmDialog({
  pending,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  pending: Pending | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const revoke = pending?.kind === "invite";
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent aria-describedby="confirm-description">
        <DialogHeader>
          <DialogTitle>{revoke ? "Revoke invite?" : "Remove member?"}</DialogTitle>
          <DialogDescription id="confirm-description">
            {revoke
              ? `The link for ${pending?.label} will stop working.`
              : `${pending?.label} will lose access to this workspace and their seat will be freed.`}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" loading={busy} onClick={onConfirm}>
            {revoke ? "Revoke" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OwnerTeam() {
  const [team, setTeam] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [seatsFull, setSeatsFull] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await call<Team>("/api/v1/team");
    if (result.ok) {
      setTeam(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    const path =
      pending.kind === "invite"
        ? `/api/v1/team/invites/${pending.id}`
        : `/api/v1/team/members/${pending.id}`;
    const result = await call<unknown>(path, { method: "DELETE" });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    setPending(null);
    setSeatsFull(false);
    await load();
  };

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {loadError}
      </p>
    );
  }
  if (!team) return <LoadingState label="Loading team…" />;

  const { used, limit } = team.seats;
  const full = seatsFull || (limit !== null && used >= limit);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Seats</CardTitle>
            <p data-testid="seat-count" className="mt-1 text-sm text-muted-foreground">
              {used} of {limit === null ? "unlimited" : limit} seats used
            </p>
          </div>
          {full ? null : (
            <Button type="button" onClick={() => setInviting(true)}>
              Invite someone
            </Button>
          )}
        </CardHeader>
        {full ? (
          <CardContent>
            <SeatExplanation />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {team.members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {member.email}
                    {member.isYou ? (
                      <span className="ml-2 text-xs text-muted-foreground">You</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{roleLabels(member.roles)}</p>
                </div>
                {member.isYou ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${member.email}`}
                    onClick={() => {
                      setActionError(null);
                      setPending({ kind: "member", id: member.userId, label: member.email });
                    }}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
        </CardHeader>
        <CardContent>
          {team.invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invites.</p>
          ) : (
            <ul className="divide-y">
              {team.invites.map((invite) => {
                const who = invite.email ?? `${roleLabel(invite.role)} invite`;
                return (
                  <li key={invite.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{who}</p>
                      <p className="text-xs text-muted-foreground">
                        {roleLabel(invite.role)} · expires {formatDate(invite.expiresAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Revoke invite for ${who}`}
                      onClick={() => {
                        setActionError(null);
                        setPending({ kind: "invite", id: invite.id, label: who });
                      }}
                    >
                      Revoke
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        onCreated={() => void load()}
        onSeatsFull={() => {
          setSeatsFull(true);
          void load();
        }}
      />
      <ConfirmDialog
        pending={pending}
        busy={busy}
        error={actionError}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}

export function TeamScreen({ me }: { me: MeResponse }) {
  const roles =
    me.memberships.find((membership) => membership.tenantId === me.tenant.id)?.roles ?? [];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      {roles.includes("owner") ? (
        <OwnerTeam />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the workspace owner can manage the team.
        </p>
      )}
    </div>
  );
}
