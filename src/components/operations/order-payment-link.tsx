"use client";

/**
 * The link a customer pays one order through (PUT /orders/:id/payment-link).
 *
 * A form that sells several items at once has no fixed price for a Stripe
 * Payment Link, so it takes no payment when it is submitted. The order it
 * raises is priced instead, and the tenant makes a link for that exact amount
 * in their own Stripe dashboard — a Payment Link or a one-off invoice — and
 * pastes it here. Graft never talks to Stripe for this: it checks the address
 * is Stripe's (`isOrderPaymentUrl`) and helps send it to the customer.
 *
 * "Email customer" has Graft send the message (POST …/payment-link/send),
 * from Graft and with replies going to whoever pressed it. "Copy message"
 * covers customers with no address on the order, or any other channel.
 */
import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon, MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, formatMoney, orderNumber } from "@/lib/bms/format";
import { INVOICE_LINK_HOST, PAYMENT_LINK_HOST, isOrderPaymentUrl } from "@/lib/payment-links";

export type OrderPaymentLinkView = {
  url: string;
  payUrl: string;
  setAt: string;
  /** When Graft last emailed this link to the customer; null if never. */
  emailedAt?: string | null;
} | null;

/** What the customer is sent, in the tenant's voice. */
export function paymentMessage(input: {
  businessName: string;
  customerName: string | null;
  orderId: string;
  amountMinor: number;
  currency: string;
  payUrl: string;
}): { subject: string; body: string } {
  const number = orderNumber(input.orderId);
  const amount = formatMoney(input.amountMinor, input.currency);
  return {
    subject: `Payment for your order ${number}`,
    body: [
      input.customerName ? `Hi ${input.customerName},` : "Hi,",
      "",
      `Thanks for your order ${number}. The amount due is ${amount}.`,
      "",
      `You can pay securely here: ${input.payUrl}`,
      "",
      input.businessName,
    ].join("\n"),
  };
}

export function OrderPaymentLink({
  orderId,
  link,
  editable,
  amountMinor,
  currency,
  businessName,
  customerName,
  customerEmail,
  onSave,
  onSend,
}: {
  orderId: string;
  link: OrderPaymentLinkView;
  /** False once the order is completed or cancelled. */
  editable: boolean;
  /** What the message asks for — the balance still due. */
  amountMinor: number;
  currency: string;
  businessName: string;
  customerName: string | null;
  customerEmail: string | null;
  /** Resolves to the server's refusal, or null when it was saved. */
  onSave: (url: string | null) => Promise<string | null>;
  /** Emails the saved link to `customerEmail`; same contract as `onSave`. */
  onSend: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(link?.url ?? "");
  const [editing, setEditing] = useState(link === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "message" | null>(null);

  useEffect(() => {
    setDraft(link?.url ?? "");
    setEditing(link === null);
  }, [link]);

  const trimmed = draft.trim();
  const invalid = trimmed !== "" && !isOrderPaymentUrl(trimmed);

  async function save(url: string | null) {
    setBusy(true);
    setError(null);
    const failure = await onSave(url);
    setBusy(false);
    if (failure) setError(failure);
  }

  async function send() {
    setBusy(true);
    setError(null);
    const failure = await onSend();
    setBusy(false);
    if (failure) setError(failure);
  }

  async function copy(kind: "link" | "message", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      setError("Your browser didn't allow copying — select the link and copy it instead.");
    }
  }

  const message = link
    ? paymentMessage({
        businessName,
        customerName,
        orderId,
        amountMinor,
        currency,
        payUrl: link.payUrl,
      })
    : null;

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div>
        <h3 className="text-sm font-medium">Payment link</h3>
        <p className="text-xs text-muted-foreground">
          Make a payment link or invoice for this amount in your Stripe dashboard, paste it here
          and send it to the customer. Record the payment below once it arrives.
        </p>
      </div>

      {link && !editing ? (
        <>
          <a
            href={link.payUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 truncate text-sm underline-offset-4 hover:underline"
          >
            <ExternalLinkIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{link.url}</span>
          </a>
          <div className="flex flex-wrap gap-2">
            {customerEmail && editable ? (
              <Button type="button" size="sm" loading={busy} onClick={() => void send()}>
                <MailIcon /> {link.emailedAt ? "Email again" : "Email customer"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copy("message", message?.body ?? link.payUrl)}
            >
              {copied === "message" ? <CheckIcon /> : <CopyIcon />} Copy message
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copy("link", link.payUrl)}
            >
              {copied === "link" ? <CheckIcon /> : <CopyIcon />} Copy link
            </Button>
            {editable ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Change
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  loading={busy}
                  onClick={() => void save(null)}
                >
                  Remove
                </Button>
              </>
            ) : null}
          </div>
          {link.emailedAt && customerEmail ? (
            <p className="text-xs text-muted-foreground">
              Emailed to {customerEmail} · {formatDateTime(link.emailedAt)}
            </p>
          ) : null}
          {!customerEmail ? (
            <p className="text-xs text-muted-foreground">
              No email address is on this order — copy the message and send it your own way.
            </p>
          ) : null}
        </>
      ) : editable ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "" || invalid) return;
            void save(trimmed);
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="order-payment-link" className="sr-only">
              Payment link
            </Label>
            <Input
              id="order-payment-link"
              inputMode="url"
              placeholder={`https://${PAYMENT_LINK_HOST}/…`}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" loading={busy} disabled={trimmed === "" || invalid}>
            Save link
          </Button>
          {link ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(link.url);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          ) : null}
          {invalid ? (
            <p role="alert" className="basis-full text-xs text-destructive">
              That is not a Stripe link. It has to start with{" "}
              <code>https://{PAYMENT_LINK_HOST}/</code> or{" "}
              <code>https://{INVOICE_LINK_HOST}/</code>.
            </p>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">No payment link was attached.</p>
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
