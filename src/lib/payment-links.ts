/**
 * GRAFT-24 — the open-redirect guard for a tenant's pasted Stripe payment
 * link (docs/BACKEND.md §5).
 *
 * Graft sends an unauthenticated visitor to a URL a tenant typed, so the only
 * defensible rule is an allow-list on the *parsed* URL: `https:` and a host
 * that is exactly `buy.stripe.com`. A substring or prefix test on the raw
 * string would accept `https://buy.stripe.com.evil.test/x` and
 * `https://evil.test/?x=buy.stripe.com` alike.
 *
 * It lives in `src/lib` rather than in the service because the form builder
 * enforces the identical rule inline, and a mirrored copy of a security rule
 * is a rule with two versions.
 */
export const PAYMENT_LINK_HOST = "buy.stripe.com";

export function isPaymentLinkUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url: URL;
  try {
    // No base is passed on purpose: a protocol-relative "//buy.stripe.com/x"
    // has no scheme of its own and must not inherit one.
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.host === PAYMENT_LINK_HOST;
}

/**
 * The URL the submitter is sent to: the tenant's own link, with Graft's
 * reference on it. Built with `URL`/`URLSearchParams` so an existing query
 * string survives and a `client_reference_id` the tenant pasted themselves is
 * overwritten rather than duplicated (AC8). Null when the stored value does
 * not (or no longer) validates — fail closed, on read as well as on write.
 */
export function buildPaymentLinkUrl(storedUrl: string, reference: string): string | null {
  if (!isPaymentLinkUrl(storedUrl)) return null;
  const url = new URL(storedUrl);
  url.searchParams.set("client_reference_id", reference);
  return url.toString();
}
