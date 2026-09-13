"use client";

/**
 * Payment collection — the control that sends a submitter to pay (GRAFT-24,
 * src/server/services/public-forms.ts).
 *
 * Three things about its shape follow from the server's rules rather than
 * taste:
 *
 *   - **It takes a link, not a key.** v1 collects through a Stripe Payment
 *     Link the tenant created in their own Stripe account, which is a public
 *     URL — so this panel stores no credential, and Graft's own Stripe
 *     account is not involved in any of it.
 *   - **The URL is checked here with the rule the server uses.** Both sides
 *     call `isPaymentLinkUrl`, so a paste that would be refused is refused
 *     visibly, beside the input, rather than as a save that throws.
 *   - **It cannot promise the money arrived.** Link mode has no webhook, so
 *     the panel says plainly that an order stays awaiting payment until the
 *     tenant confirms it on the order board. Anything softer would read as a
 *     guarantee this cannot make.
 *
 * Saved with an explicit button, like the panels beside it: this decides what
 * happens to a customer's money.
 */
import { useEffect, useState } from "react";
import { CreditCardIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PAYMENT_LINK_HOST, isPaymentLinkUrl } from "@/lib/payment-links";

/** Mirrors `PaymentConfig` in src/server/services/forms.ts. */
export type PaymentView = {
  mode: "link";
  link: { url: string };
  required: boolean;
};

export function PaymentEditor({
  payment,
  busy,
  onSave,
}: {
  payment: PaymentView | null;
  busy: boolean;
  onSave: (next: PaymentView | null) => void;
}) {
  const [enabled, setEnabled] = useState(payment !== null);
  const [url, setUrl] = useState(payment?.link.url ?? "");
  const [required, setRequired] = useState(payment?.required ?? false);

  // Re-seed when the server's answer arrives or changes under us.
  useEffect(() => {
    setEnabled(payment !== null);
    setUrl(payment?.link.url ?? "");
    setRequired(payment?.required ?? false);
  }, [payment]);

  const invalid = url.trim() !== "" && !isPaymentLinkUrl(url.trim());
  const ready = isPaymentLinkUrl(url.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCardIcon className="size-4" aria-hidden="true" /> Payment
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Send whoever submits this form to a Stripe payment link of yours. Create the link in
          your own Stripe account and paste it here — Graft never sees your Stripe keys.
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
                  The order id travels with the visitor as <code>client_reference_id</code>, so
                  you can tell which payment belongs to which booking in Stripe.
                </p>
              )}
            </div>

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
                  thank-you page offers the link instead.
                </span>
              </span>
            </label>

            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Either way the submission is kept the moment it is sent — payment is not verified
              here. An order raised by this form stays in <strong>Awaiting payment</strong> on
              the orders board until you confirm it.
            </p>
          </>
        ) : null}

        <div>
          <Button
            type="button"
            size="sm"
            disabled={busy || (enabled && !ready)}
            onClick={() =>
              onSave(enabled ? { mode: "link", link: { url: url.trim() }, required } : null)
            }
          >
            {busy ? "Saving…" : "Save payment"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
