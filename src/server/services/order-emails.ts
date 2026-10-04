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
import { ObjectId } from "mongodb";
import { env } from "@/env";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { orderPaidEmail, orderPaidOwnerEmail, orderPaymentEmail } from "@/server/mail/messages";
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

export type PaidEmailDeps = {
  loadOrder: OrderEmailDeps["loadOrder"];
  accounts: Pick<AccountStore, "findTenantById">;
  /** Addresses of the workspace's owners. */
  ownerEmails: (tenantId: string) => Promise<string[]>;
  sendMail: OrderEmailDeps["sendMail"];
  appUrl: () => string;
};

async function mongoOwnerEmails(tenantId: string): Promise<string[]> {
  if (!ObjectId.isValid(tenantId)) return [];
  const users = (await getDb()).collection<{ email?: string }>("users");
  const docs = await users
    .find(
      { memberships: { $elemMatch: { tenantId: new ObjectId(tenantId), roles: "owner" } } },
      { projection: { email: 1 } },
    )
    .toArray();
  return docs.map((d) => d.email).filter((e): e is string => Boolean(e));
}

/**
 * After a card payment is recorded (the Connect webhook): a confirmation to the
 * customer and a notice to the workspace's owners.
 *
 * **Never throws.** The payment is already on the order; a mail outage must not
 * turn into a failed webhook, because Stripe would retry a delivery whose money
 * has been recorded. Each message is sent on its own, so one bounce doesn't
 * cost the other. Duplicate deliveries are stopped upstream (the event claim).
 */
export async function sendOrderPaidEmails(
  ctx: Ctx,
  orderId: string,
  paidMinor: number,
  overrides: Partial<PaidEmailDeps> = {},
): Promise<void> {
  const log = createLogger({ requestId: ctx.requestId });
  try {
    const deps: PaidEmailDeps = {
      loadOrder:
        overrides.loadOrder ?? (async (c, id) => orderWithCustomer(c, await getOrder(c, id))),
      accounts: overrides.accounts ?? mongoAccountStore(),
      ownerEmails: overrides.ownerEmails ?? mongoOwnerEmails,
      sendMail: overrides.sendMail ?? sendMail,
      appUrl: overrides.appUrl ?? (() => env().APP_URL),
    };
    const [order, tenant, owners] = await Promise.all([
      deps.loadOrder(ctx, orderId),
      deps.accounts.findTenantById(ctx.tenantId),
      deps.ownerEmails(ctx.tenantId),
    ]);
    const input = {
      businessName: tenant?.name ?? "Your order",
      customerName: order.customer?.name ?? null,
      orderId: order.id,
      paidMinor,
      balanceMinor: order.balanceMinor,
      currency: order.currency,
      confirmed: order.status === "confirmed",
    };
    const customerEmail = order.customer?.email;

    const sends: Promise<void>[] = [];
    if (customerEmail) {
      sends.push(
        deps.sendMail({
          kind: "order.paid",
          to: customerEmail,
          replyTo: owners[0],
          fromName: `${input.businessName} via Graft`,
          ...orderPaidEmail(input),
        }),
      );
    }
    for (const to of owners) {
      sends.push(
        deps.sendMail({
          kind: "order.paid_owner",
          to,
          replyTo: customerEmail ?? undefined,
          fromName: "Graft",
          ...orderPaidOwnerEmail({
            ...input,
            orderUrl: `${deps.appUrl()}/operations/orders/${order.id}`,
          }),
        }),
      );
    }
    const results = await Promise.allSettled(sends);
    for (const r of results) {
      if (r.status === "rejected") {
        log.error("order.paid_email_failed", {
          tenantId: ctx.tenantId,
          orderId,
          error: r.reason,
        });
      }
    }
  } catch (error) {
    log.error("order.paid_email_failed", { tenantId: ctx.tenantId, orderId, error });
  }
}
