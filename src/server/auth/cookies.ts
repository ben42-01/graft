/**
 * Cookie delivery for the session pair (docs/BACKEND.md §3.1, AC7).
 * PROTECTED PATH (.github/agent-policy.yml).
 *
 * Both cookies are httpOnly — the access token goes in a cookie precisely so it
 * is not in localStorage where an XSS can read it. `Authorization: Bearer` stays
 * supported for the public API and connectors, which have no cookie jar.
 *
 * Secure is unconditional. In local QA over http the browser would drop it, but
 * the Bruno suite reads the header rather than storing it, and a flag that is
 * conditional on the environment is a flag that will one day be off in the
 * environment that needed it.
 */
export const REFRESH_COOKIE = "graft_refresh";
export const ACCESS_COOKIE = "graft_access";

/**
 * The refresh cookie is only ever spent at /api/v1/auth, so that is the only
 * path it is sent on — a stray XSS-driven fetch to a business endpoint cannot
 * make the browser attach it.
 */
const REFRESH_PATH = "/api/v1/auth";

type CookieOptions = { maxAge: number; path: string };

function serialize(name: string, value: string, { maxAge, path }: CookieOptions): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const refreshCookie = (value: string, maxAgeSeconds: number): string =>
  serialize(REFRESH_COOKIE, value, { maxAge: maxAgeSeconds, path: REFRESH_PATH });

export const accessCookie = (value: string, maxAgeSeconds: number): string =>
  serialize(ACCESS_COOKIE, value, { maxAge: maxAgeSeconds, path: "/" });

/** Cleared with the same name/path/flags they were set with, or they survive. */
export const clearedCookies = (): string[] => [
  serialize(REFRESH_COOKIE, "", { maxAge: 0, path: REFRESH_PATH }),
  serialize(ACCESS_COOKIE, "", { maxAge: 0, path: "/" }),
];

/**
 * Minimal Cookie-header parse. Only the two names above are ever looked up, and
 * the value is handed straight to a validator, so nothing here has to be clever.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `Authorization: Bearer <token>` first, then the httpOnly cookie. */
export function readAccessToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/);
    if (scheme.toLowerCase() !== "bearer" || rest.length !== 1) return null;
    return rest[0];
  }
  return readCookie(request, ACCESS_COOKIE);
}
