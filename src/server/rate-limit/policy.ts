/**
 * Which scopes apply to which route (docs/BACKEND.md §4, agent-policy security
 * checklist: "Rate limiting declared for any new endpoint").
 *
 * A route states its scope declaratively — either by passing a policy to
 * `route(handler, { rateLimit })`, or by matching a row here. The table is the
 * default so that the checklist item is satisfied by *omission*: a new endpoint
 * lands rate limited whether or not its author remembered, and forgetting is a
 * loosening you have to write down rather than one you get for free.
 */
import type { RateLimitScope } from "./scopes";

export type RoutePolicy = {
  scopes: readonly RateLimitScope[];
  /** Overrides MAX_BODY_BYTES for routes that should accept less. */
  bodyLimitBytes?: number;
};

const GLOBAL_ONLY: RoutePolicy = { scopes: ["global-ip"] };

/** First match wins, so the specific rows come before the general ones. */
const TABLE: ReadonlyArray<{ pattern: RegExp; policy: RoutePolicy }> = [
  // Probes are how the platform decides the process is alive; throttling them
  // would take a healthy instance out of rotation under load.
  { pattern: /^\/api\/(health|ready)\/?$/, policy: { scopes: [] } },

  // The credential-guessing surface: ip + email, charged on failure only (AC3).
  {
    pattern: /^\/api\/v1\/auth\/(login|signup|verify-email)\b/,
    policy: { scopes: ["global-ip", "auth"] },
  },

  // Rotation and logout present a token, not a guess; the auth budget would only
  // lock out a browser doing exactly what it is supposed to.
  { pattern: /^\/api\/v1\/auth\//, policy: GLOBAL_ONLY },

  // The only unauthenticated write surface in the product (docs/BACKEND.md §5).
  { pattern: /^\/api\/v1\/public\//, policy: { scopes: ["global-ip", "public-form"] } },

  // Everything else authenticated: tenant budget by tier, plus the per-user cap.
  { pattern: /^\/api\/v1\//, policy: { scopes: ["global-ip", "api", "user"] } },
];

export function policyForPath(pathname: string): RoutePolicy {
  return TABLE.find(({ pattern }) => pattern.test(pathname))?.policy ?? GLOBAL_ONLY;
}
