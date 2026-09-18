"use client";

/**
 * The tier-override control on `/admin/tenants/[tenantId]` (GRAFT-27.4 AC10).
 *
 * An addition to the GRAFT-27.3 detail screen, not a screen of its own: the
 * operator is already looking at the tenant they are about to move, and a
 * separate page would lose that context at exactly the wrong moment.
 *
 * Two steps, deliberately. The first collects the tier and the reason; the
 * second does nothing but ask again, naming the tenant and saying plainly what
 * this does and does not do. The separation is the point — a single button that
 * changes a customer's plan is too easy to hit, and the confirm step is where
 * the operator reads the tenant's name and notices they are on the wrong tab.
 *
 * Three properties the component test pins:
 *
 *   - **The reason is required here too**, not only at the API boundary. A
 *     server-side 400 for a missing reason is correct but arrives after the
 *     operator has already committed; refusing to advance is kinder and keeps
 *     `reason` feeling like a field rather than an obstacle.
 *   - **The confirm step names the tenant and states that Stripe billing is not
 *     changed.** That is the contract's headline out-of-scope note: a tenant
 *     with a live subscription can be put on `free` here and Stripe will keep
 *     billing them. Leaving that to institutional memory is how a support tool
 *     becomes a refund incident.
 *   - **Cancelling issues no request.** Not "issues one and ignores it" — the
 *     test asserts the fetch spy was never called.
 *
 * There is no optimistic update: the tier shown on the screen is re-read from
 * the server via `onApplied`, because `readOnly` and the materialised limits
 * are computed by applyDowngradePolicy and this component has no business
 * guessing them.
 */
import { useState } from "react";
import { TIERS, type Tier } from "@/server/tiers";

/** The slice of the detail payload this control needs. */
export type TierOverrideTenant = {
  id: string;
  name: string;
  slug: string;
  tier: string;
};

export type TierOverrideDialogProps = {
  tenant: TierOverrideTenant;
  /** Called after a successful override, so the screen can re-read the tenant. */
  onApplied?: () => void;
};

type Step = "closed" | "form" | "confirm";

type Outcome = {
  fromTier: string;
  toTier: string;
  changed: boolean;
  readOnly: string[];
};

export const MAX_REASON_LENGTH = 500;

export function TierOverrideDialog({ tenant, onApplied }: TierOverrideDialogProps) {
  const [step, setStep] = useState<Step>("closed");
  const [tier, setTier] = useState<Tier>((tenant.tier as Tier) ?? "free");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  function reset() {
    setStep("closed");
    setReason("");
    setError(null);
    setSubmitting(false);
  }

  function onContinue() {
    // AC10 — trimmed, so a field of spaces is not a reason. The same rule the
    // service applies (`z.string().trim().min(1)`), stated here so the operator
    // hears it before they commit rather than after.
    if (!reason.trim()) {
      setError("A reason is required — it is written to the audit log.");
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function onConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/admin/tenants/${tenant.id}/tier`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, reason: reason.trim() }),
      });
      if (!response.ok) {
        setError("Couldn't change the tier. Nothing was applied — please try again.");
        setSubmitting(false);
        setStep("form");
        return;
      }
      const body = (await response.json()) as { data: Outcome };
      setOutcome(body.data);
      reset();
      onApplied?.();
    } catch {
      setError("Couldn't change the tier. Nothing was applied — please try again.");
      setSubmitting(false);
      setStep("form");
    }
  }

  if (step === "closed") {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => {
            setOutcome(null);
            setTier((tenant.tier as Tier) ?? "free");
            setStep("form");
          }}
          className="rounded border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Change tier
        </button>
        {outcome ? (
          <p className="text-sm text-muted-foreground" role="status">
            {outcome.changed
              ? `${outcome.fromTier} → ${outcome.toTier}. Stripe was not changed.`
              : `Already on ${outcome.toTier} — nothing changed, and the action was logged.`}
          </p>
        ) : null}
      </div>
    );
  }

  if (step === "form") {
    return (
      <div className="flex w-full max-w-md flex-col gap-3 rounded border border-border p-4">
        <h3 className="text-sm font-semibold">Change tier</h3>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">New tier</span>
          <select
            value={tier}
            onChange={(event) => setTier(event.target.value as Tier)}
            className="rounded border border-border bg-background px-2 py-1.5"
          >
            {TIERS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            Reason (required, written to the audit log)
          </span>
          <textarea
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            rows={3}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. comped for launch partner"
            className="rounded border border-border bg-background px-2 py-1.5"
          />
        </label>

        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded border border-border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tier-override-confirm-heading"
      className="flex w-full max-w-md flex-col gap-3 rounded border border-border p-4"
    >
      <h3 id="tier-override-confirm-heading" className="text-sm font-semibold">
        Confirm tier change
      </h3>

      <p className="text-sm">
        Move <strong>{tenant.name}</strong> (<code>{tenant.slug}</code>) from{" "}
        <strong>{tenant.tier}</strong> to <strong>{tier}</strong>.
      </p>

      {/* The out-of-scope warning the contract requires, in words, at the last
          moment before it is applied. */}
      <p className="rounded bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
        Stripe billing is not changed by this action. No subscription is created, cancelled or
        refunded, and a tenant with a live subscription will keep being billed. Change the
        subscription in Stripe separately if that is what you meant.
      </p>

      <p className="text-sm text-muted-foreground">
        Moving down a tier freezes anything over the new limits and unpublishes public forms
        beyond the new cap. Nothing is deleted. Your reason is stored in the audit log.
      </p>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded border border-border px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void onConfirm()}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-60"
        >
          Confirm tier change
        </button>
      </div>
    </div>
  );
}
