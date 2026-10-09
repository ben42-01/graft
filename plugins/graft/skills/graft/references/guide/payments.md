# Payments

_Take payment through Stripe: connected account checkout, payment links or manual._

Customers can pay for what they book or order. How is set per form, in its **Payment** panel. There are three modes.

| Mode | What happens | Payment confirmed? | Cart forms |
|---|---|---|---|
| **Checkout** (recommended) | The customer pays by card through Stripe Checkout, on **your own** Stripe account, for the order's amount due | Yes, automatically | Yes |
| **Payment link** | The customer is redirected to a Stripe Payment Link you made | No; you confirm by hand | No (a link has a fixed price) |
| **Manual** | Nothing is redirected. Your instructions (up to 1,000 characters) show on the thank-you page | No; you record payments on the order | Yes |

You can mark payment as **required** or optional for checkout and link modes.

## Checkout (recommended)

An owner or manager connects a Stripe account once, under **Account**. Graft then creates Checkout sessions on that connected account. The payment goes to you and the order is updated automatically. Graft sends the customer a payment confirmation and notifies the workspace owners.

> **Note:** Graft **never asks for your Stripe API keys.** A connected account does the same job without Graft holding a credential that can move your money.
## Payment links

Paste a Stripe Payment Link (`https://buy.stripe.com/…`). Anything else is refused, so a form can never be pointed at another site. Graft stores no Stripe credentials for this and receives no confirmation, so mark the order paid yourself.

## Paying a cart order

A cart has no fixed price, so the form takes no payment at submit. The order is priced from your records. You then make a Payment Link or one-off invoice in your Stripe dashboard for that amount and **attach it to the order**. Only `buy.stripe.com` and `invoice.stripe.com` links are accepted. From the order you can **email the link to the customer** from Graft, with replies going to you.

## Recording payments by hand

On any order, record money received with an amount and an optional reference, such as a bank transfer number. The order's balance updates.

## Your Graft subscription

Separately, upgrading to Premium is paid to Graft through Stripe Checkout by the owner, under **Account**.
