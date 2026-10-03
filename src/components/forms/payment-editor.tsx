"use client";

/**
 * Payment collection — the control that sends a submitter to pay (GRAFT-24,
 * src/server/services/public-forms.ts).
 *
 * Two ways to take money, chosen per form:
 *
 *   - **Payment link.** A Stripe Payment Link the tenant created in their own
 *     account — a public URL, so this panel stores no credential. The URL is
 *     checked here with the rule the server uses (`isPaymentLinkUrl`), so a
 *     paste that would be refused is refused beside the input. It cannot
 *     verify payment, and the panel says so.
 *   - **Stripe Checkout.** Graft opens a Checkout Session on the tenant's own
 *     *connected* Stripe account (src/server/services/stripe-connect.ts) for
 *     the amount due on the booking's order, and marks the order paid when
 *     Stripe says it is. It needs the account connected, which this panel
 *     offers in place, and it needs an order to charge — so it says so when
 *     the form takes no bookings.
 *
 * Saved with an explicit button, like the panels beside it: this decides what
 * happens to a customer's money.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, CreditCardIcon, LinkIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PAYMENT_LINK_HOST, isPaymentLinkUrl } from "@/lib/payment-links";
import { cn } from "@/lib/utils";

/** Mirrors `PaymentConfig` in src/server/services/forms.ts. */
export type PaymentView =
  | { mode: "link"; link: { url: string }; required: boolean }
  | { mode: "checkout"; required: boolean };

type Mode = PaymentView["mode"];

/** Mirrors `ConnectStatus` in src/server/services/stripe-connect.ts. */
type ConnectStatus = { connected: boolean; chargesEnabled: boolean; detailsSubmitted: boolean };

type ConnectState =
  { status: "loading" } | { status: "error" } | { status: "ready"; value: ConnectStatus };

export function PaymentEditor({
  payment,
  busy,
  onSave,
  formId,
  hasBooking = false,
}: {
  payment: PaymentView | null;
  busy: boolean;
  onSave: (next: PaymentView | null) => void;
  /** Where Stripe onboarding comes back to. */
  formId?: string;
  /** Checkout charges the order a booking raises; without one it has no amount. */
  hasBooking?: boolean;
}) {
  const [enabled, setEnabled] = useState(payment !== null);
  const [mode, setMode] = useState<Mode>(payment?.mode ?? "link");
  const [url, setUrl] = useState(payment?.mode === "link" ? payment.link.url : "");
  const [required, setRequired] = useState(payment?.required ?? false);

  // Re-seed when the server's answer arrives or changes under us.
  useEffect(() => {
    setEnabled(payment !== null);
    setMode(payment?.mode ?? "link");
    setUrl(payment?.mode === "link" ? payment.link.url : "");
    setRequired(payment?.required ?? false);
  }, [payment]);

  const invalid = url.trim() !== "" && !isPaymentLinkUrl(url.trim());
  const linkReady = isPaymentLinkUrl(url.trim());

  const [connect, reloadConnect] = useConnectStatus(enabled && mode === "checkout");
  const checkoutReady = connect.status === "ready" && connect.value.chargesEnabled;
  const ready = mode === "link" ? linkReady : checkoutReady;

  function save() {
    if (!enabled) return onSave(null);
    onSave(
      mode === "link"
        ? { mode: "link", link: { url: url.trim() }, required }
        : { mode: "checkout", required },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCardIcon className="size-4" aria-hidden="true" /> Payment
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask whoever submits this form to pay — through a Stripe payment link you made, or a
          Stripe Checkout Graft opens on your own Stripe account.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={enabled}
            disabled={busy}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          Take payment with this form
        </label>

        {enabled ? (
          <>
            <div
              role="radiogroup"
              aria-label="How to take payment"
              className="grid gap-2 sm:grid-cols-2"
            >
              <ModeOption
                selected={mode === "link"}
                disabled={busy}
                onSelect={() => setMode("link")}
                icon={<LinkIcon className="size-4" aria-hidden="true" />}
                title="Payment link"
                body="Paste a link from your Stripe dashboard. You confirm payment yourself."
              />
              <ModeOption
                selected={mode === "checkout"}
                disabled={busy}
                onSelect={() => setMode("checkout")}
                icon={<CreditCardIcon className="size-4" aria-hidden="true" />}
                title="Stripe Checkout"
                body="Charges the booking's amount due and marks the order paid automatically."
              />
            </div>

            {mode === "link" ? (
              <div>
                <Label htmlFor="payment-url" className="mb-1 block text-xs">
                  Payment link
                </Label>
                <Input
                  id="payment-url"
                  inputMode="url"
                  placeholder={`https://${PAYMENT_LINK_HOST}/…`}
                  value={url}
                  disabled={busy}
                  onChange={(event) => setUrl(event.target.value)}
                />
                {invalid ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    That is not a Stripe payment link. It has to start with{" "}
                    <code>https://{PAYMENT_LINK_HOST}/</code> — copy it from the Payment links
                    page in your Stripe dashboard.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    The order id travels with the visitor as <code>client_reference_id</code>,
                    so you can tell which payment belongs to which booking in Stripe.
                  </p>
                )}
              </div>
            ) : (
              <CheckoutSetup
                connect={connect}
                formId={formId}
                hasBooking={hasBooking}
                onDisconnected={reloadConnect}
              />
            )}

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={required}
                disabled={busy}
                onCheckedChange={(checked) => setRequired(checked === true)}
              />
              <span>
                Send them straight to payment
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  On, the browser goes to Stripe as soon as the form is submitted. Off, the
                  thank-you page offers a Pay now button instead.
                </span>
              </span>
            </label>

            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              {mode === "link" ? (
                <>
                  Either way the submission is kept the moment it is sent — payment is not
                  verified here. An order raised by this form stays in{" "}
                  <strong>Awaiting payment</strong> on the orders board until you confirm it.
                </>
              ) : (
                <>
                  The submission is kept the moment it is sent. When Stripe reports the payment,
                  it is recorded on the order, which confirms itself once the deposit (or the
                  total) is covered. Money goes straight to your Stripe account.
                </>
              )}
            </p>
          </>
        ) : null}

        <div>
          <Button
            loading={busy}
            type="button"
            size="sm"
            disabled={busy || (enabled && !ready)}
            onClick={save}
          >
            {busy ? "Saving…" : "Save payment"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ModeOption({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  body,
}: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-graft-green bg-graft-green/5 ring-1 ring-graft-green"
          : "hover:border-foreground/30",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{body}</span>
    </button>
  );
}

function useConnectStatus(active: boolean): [ConnectState, () => Promise<void>] {
  const [state, setState] = useState<ConnectState>({ status: "loading" });
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/payments/stripe-connect", {
        credentials: "include",
      });
      if (!response.ok) return setState({ status: "error" });
      const { data } = (await response.json()) as { data: ConnectStatus };
      setState({ status: "ready", value: data });
    } catch {
      setState({ status: "error" });
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  return [state, load];
}

function CheckoutSetup({
  connect,
  formId,
  hasBooking,
  onDisconnected,
}: {
  connect: ConnectState;
  formId?: string;
  hasBooking: boolean;
  onDisconnected: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startOnboarding() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/payments/stripe-connect/onboarding", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo: formId ? `/forms/${formId}` : "/forms" }),
      });
      const body = (await response.json().catch(() => null)) as
        { data: { url: string } } | { error: { message: string } } | null;
      if (!response.ok || !body || !("data" in body)) {
        setError(
          body && "error" in body ? body.error.message : "We couldn't reach Stripe just now.",
        );
        return;
      }
      window.location.assign(body.data.url);
    } catch {
      setError("We couldn't reach Stripe just now.");
    } finally {
      setStarting(false);
    }
  }

  // Forgets the link to the Stripe account (the account itself stays the
  // owner's), so they can connect a different one or start onboarding afresh.
  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect this Stripe account from Graft? The account itself is not deleted — you can connect it or a different one afterwards.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/payments/stripe-connect", {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        setError("We couldn't disconnect Stripe just now.");
        return;
      }
      await onDisconnected();
    } catch {
      setError("We couldn't disconnect Stripe just now.");
    } finally {
      setDisconnecting(false);
    }
  }

  const disconnectButton =
    connect.status === "ready" && connect.value.connected ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        disabled={disconnecting}
        onClick={() => void disconnect()}
      >
        {disconnecting ? "Disconnecting…" : "Use a different Stripe account"}
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      {connect.status === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> Checking your
          Stripe connection…
        </p>
      ) : connect.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          We couldn&apos;t check your Stripe connection. Reload to try again.
        </p>
      ) : connect.value.chargesEnabled ? (
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2Icon className="size-4 text-graft-green" aria-hidden="true" />
          Stripe account connected and ready to take payments.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            {connect.value.connected
              ? "Your Stripe account isn't ready to take payments yet — finish setting it up with Stripe."
              : "Connect your Stripe account so customers can pay by card. Payments go straight to you."}
          </p>
          <Button
            type="button"
            size="sm"
            className="self-start"
            disabled={starting}
            onClick={() => void startOnboarding()}
          >
            {starting
              ? "Opening Stripe…"
              : connect.value.connected
                ? "Continue Stripe setup"
                : "Connect Stripe"}
          </Button>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      )}
      {disconnectButton}

      {!hasBooking ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Checkout charges the amount due on the order a booking raises. This form takes no
          bookings yet, so card payment won&apos;t be offered until you set bookings up above.
        </p>
      ) : null}
    </div>
  );
}
