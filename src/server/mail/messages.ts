/**
 * The words of each email Graft sends. Every builder returns the subject and
 * the rendered template; who it goes to and who replies are the caller's.
 *
 * Builders are pure — no env, no clock, no I/O — so each one is tested by
 * reading its output.
 */
import { formatMoney, orderNumber } from "@/lib/bms/format";
import { roleLabel } from "@/lib/role-labels";
import { renderEmail } from "./template";

export type BuiltEmail = { subject: string; html: string; text: string };

export function verificationEmail(input: { url: string; ttlHours: number }): BuiltEmail {
  return {
    subject: "Confirm your email for Graft",
    ...renderEmail({
      preheader: "One click and your workspace is ready.",
      heading: "Confirm your email address",
      paragraphs: [
        "Welcome to Graft. Confirm this is your email address and you can log in to your workspace.",
      ],
      action: { label: "Confirm email", url: input.url },
      footnote: `This link works once and expires in ${input.ttlHours} hours. If you didn't sign up for Graft, ignore this email — no account is activated without it.`,
    }),
  };
}

export function inviteEmail(input: {
  businessName: string;
  role: string;
  url: string;
  ttlDays: number;
}): BuiltEmail {
  return {
    subject: `You're invited to join ${input.businessName} on Graft`,
    ...renderEmail({
      preheader: `Join ${input.businessName} as ${roleLabel(input.role)}.`,
      heading: `Join ${input.businessName} on Graft`,
      paragraphs: [
        `You've been invited to join ${input.businessName} as ${roleLabel(input.role)}.`,
        "Accept the invite to sign in, or to create your account if you don't have one yet.",
      ],
      action: { label: "Accept invite", url: input.url },
      footnote: `This invite expires in ${input.ttlDays} days. If you weren't expecting it, you can ignore this email.`,
    }),
  };
}

export function orderPaymentEmail(input: {
  businessName: string;
  customerName: string | null;
  orderId: string;
  amountMinor: number;
  currency: string;
  payUrl: string;
}): BuiltEmail {
  const number = orderNumber(input.orderId);
  const amount = formatMoney(input.amountMinor, input.currency);
  return {
    subject: `Payment for your order ${number}`,
    ...renderEmail({
      preheader: `${amount} due for order ${number}.`,
      heading: `Your order ${number}`,
      paragraphs: [
        input.customerName ? `Hi ${input.customerName},` : "Hi,",
        `Thanks for your order with ${input.businessName}. The amount due is ${amount}.`,
      ],
      action: { label: `Pay ${amount}`, url: input.payUrl },
      signoff: input.businessName,
      footnote:
        "Payment is handled securely by Stripe. Questions about your order? Reply to this email.",
    }),
  };
}

type PaidInput = {
  businessName: string;
  customerName: string | null;
  orderId: string;
  /** What this payment was — not the order's running total. */
  paidMinor: number;
  /** Still owed after this payment; 0 when the order is settled. */
  balanceMinor: number;
  currency: string;
  confirmed: boolean;
};

const balanceLine = (input: PaidInput): string =>
  input.balanceMinor > 0
    ? `The remaining balance is ${formatMoney(input.balanceMinor, input.currency)}.`
    : "Your order is paid in full.";

/** To the customer, when their card payment has been recorded. */
export function orderPaidEmail(input: PaidInput): BuiltEmail {
  const number = orderNumber(input.orderId);
  const amount = formatMoney(input.paidMinor, input.currency);
  return {
    subject: `Payment received for order ${number}`,
    ...renderEmail({
      preheader: `We received ${amount} for order ${number}.`,
      heading: "Payment received",
      paragraphs: [
        input.customerName ? `Hi ${input.customerName},` : "Hi,",
        `Thank you — ${input.businessName} received your payment of ${amount} for order ${number}.`,
        balanceLine(input),
        ...(input.confirmed ? ["Your order is confirmed."] : []),
      ],
      signoff: input.businessName,
      footnote: "Keep this email for your records. Questions about your order? Reply to it.",
    }),
  };
}

/** To the business owner, so a payment never goes unnoticed. */
export function orderPaidOwnerEmail(input: PaidInput & { orderUrl: string }): BuiltEmail {
  const number = orderNumber(input.orderId);
  const amount = formatMoney(input.paidMinor, input.currency);
  const who = input.customerName ?? "A customer";
  return {
    subject: `${amount} received for order ${number}`,
    ...renderEmail({
      preheader: `${who} paid ${amount}.`,
      heading: "You've been paid",
      paragraphs: [
        `${who} paid ${amount} for order ${number}.`,
        input.balanceMinor > 0
          ? `${formatMoney(input.balanceMinor, input.currency)} is still outstanding.`
          : "The order is paid in full.",
        ...(input.confirmed ? ["The order has been marked confirmed."] : []),
      ],
      action: { label: "View order", url: input.orderUrl },
      footnote: "Sent to the owners of this workspace when a card payment arrives.",
    }),
  };
}
