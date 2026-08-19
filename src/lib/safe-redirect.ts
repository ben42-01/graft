/**
 * GRAFT-18 AC7 — the open-redirect guard for the `redirect` query param on
 * `/login`. Only a same-origin relative path is ever honoured; anything else
 * (an absolute URL, or a protocol-relative `//evil.com`, which the browser
 * resolves against its own scheme) falls back to the authenticated home.
 *
 * Falls back to `/home`, not `/` (GRAFT-19 AC8): `/` is now the public
 * marketing/pricing page, and a caller who didn't ask to go anywhere
 * specific means the app's authenticated landing screen.
 */
export function sanitizeRedirectTarget(raw: string | null | undefined): string {
  if (!raw) return "/home";
  // Protocol-relative ("//evil.com") first — it does start with "/" so the
  // single-slash check below would let it through.
  if (raw.startsWith("//")) return "/home";
  if (!raw.startsWith("/")) return "/home";
  return raw;
}
