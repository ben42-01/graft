/**
 * Emails a customer the link they pay their order through
 * (POST /orders/:orderId/payment-link/send). It replaces the `mailto:` button
 * PR #145 left in its place: Graft now sends the message itself.
 *
 *   - **From Graft, replies to the business.** The sender is the configured
 *     mailbox, shown as "<Business> via Graft", and Reply-To is whoever pressed
 *     Send — so a customer's "is this right?" reaches a person who can answer.
 *   - **Only what the order page already shows.** The customer's address is
 *     the one derived from their form submission (customers.ts), and the link
 *     is the stored, allow-listed Stripe URL — nothing in the request body is
 *     sent anywhere.
 *   - **A short cooldown.** One send per order per minute, so a double click
 *     or an impatient retry is one email, not three, and the shared mailbox's
 *     daily cap is not spent by accident.
 */
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { orderPaymentEmail } from "@/server/mail/messages";
import { sendMail, type MailMessage } from "@/server/mail/transport";
import { mongoAccountStore, type AccountStore } from "@/server/auth/accounts-store";
import type { Ctx } from "@/server/context";
import { orderWithCustomer, type OrderWithCustomer } from "./customers";
import {
  ACTIVE_STATUSES,
  getOrder,
  markPaymentLinkEmailed,
  orderIdParamSchema,
  type OrderView,
} from "./orders";

export const PAYMENT_EMAIL_COOLDOWN_MS = 60 * 1000;

export type OrderEmailDeps = {
  loadOrder: (ctx: Ctx, orderId: string) => Promise<OrderWithCustomer>;
  accounts: Pick<AccountStore, "findTenantById" | "findUserById">;
  markEmailed: (ctx: Ctx, orderId: string) => Promise<OrderView>;
  sendMail: (message: MailMessage) => Promise<void>;
  now: () => Date;
};

function resolveDeps(overrides: Partial<OrderEmailDeps> = {}): OrderEmailDeps {
  return {
    loadOrder:
      overrides.loadOrder ??
      (async (ctx, orderId) => orderWithCustomer(ctx, await getOrder(ctx, orderId))),
    accounts: overrides.accounts ?? mongoAccountStore(),
    markEmailed:
      overrides.markEmailed ?? ((ctx, orderId) => markPaymentLinkEmailed(ctx, orderId)),
    sendMail: overrides.sendMail ?? sendMail,
    now: overrides.now ?? (() => new Date()),
  };
}

const conflict = (message: string): never => {
  throw new AppError("CONFLICT", message);
};

export async function sendOrderPaymentLink(
  ctx: Ctx,
  orderId: string,
  overrides: Partial<OrderEmailDeps> = {},
): Promise<OrderView> {
  parse(orderIdParamSchema, { orderId }, "params");
  const deps = resolveDeps(overrides);
  const order = await deps.loadOrder(ctx, orderId);

  if (!ACTIVE_STATUSES.includes(order.status)) {
    conflict(`A ${order.status} order cannot be sent a payment link`);
  }
  const link = order.paymentLink;
  if (!link) return conflict("Add a payment link to this order before emailing it");
  if (order.balanceMinor <= 0) conflict("Nothing is left to pay on this order");
  const to = order.customer?.email;
  if (!to) return conflict("This order has no customer email address to send to");

  const last = link.emailedAt ? new Date(link.emailedAt).getTime() : null;
  if (last !== null && deps.now().getTime() - last < PAYMENT_EMAIL_COOLDOWN_MS) {
    throw new AppError(
      "RATE_LIMITED",
      "The payment link was just sent. Wait a minute to resend.",
    );
  }

  const [tenant, sender] = await Promise.all([
    deps.accounts.findTenantById(ctx.tenantId),
    deps.accounts.findUserById(ctx.userId),
  ]);
  const businessName = tenant?.name ?? "Your order";

  try {
    await deps.sendMail({
      kind: "order.payment_link",
      to,
      replyTo: sender?.email,
      fromName: `${businessName} via Graft`,
      ...orderPaymentEmail({
        businessName,
        customerName: order.customer?.name ?? null,
        orderId: order.id,
        amountMinor: order.balanceMinor,
        currency: order.currency,
        payUrl: link.payUrl,
      }),
    });
  } catch (error) {
    createLogger({ requestId: ctx.requestId }).error("order.payment_link_email_failed", {
      tenantId: ctx.tenantId,
      orderId,
      error,
    });
    throw new AppError(
      "INTERNAL",
      "The email couldn't be sent. Try again, or copy the message and send it yourself.",
    );
  }

  createLogger({ requestId: ctx.requestId }).info("order.payment_link_emailed", {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    orderId,
  });
  return deps.markEmailed(ctx, orderId);
}
