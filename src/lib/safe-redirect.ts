/**
 * GRAFT-18 AC7 — the open-redirect guard for the `redirect` query param on
 * `/login`. Only a same-origin relative path is ever honoured; anything else
 * (an absolute URL, or a protocol-relative `//evil.com`, which the browser
 * resolves against its own scheme) falls back to `/`.
 */
export function sanitizeRedirectTarget(raw: string | null | undefined): string {
  if (!raw) return "/";
  // Protocol-relative ("//evil.com") first — it does start with "/" so the
  // single-slash check below would let it through.
  if (raw.startsWith("//")) return "/";
  if (!raw.startsWith("/")) return "/";
  return raw;
}
