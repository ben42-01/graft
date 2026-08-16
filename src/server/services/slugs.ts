/**
 * Slug derivation (GRAFT-03.2 AC5).
 *
 * A tenant slug is public and load-bearing: it is the first segment of every
 * published form URL, `graft.app/f/{tenantSlug}/{formSlug}` (docs/Graft.md §5).
 * So it has to be URL-safe by construction rather than by escaping, and it must
 * not be allowed to shadow a platform route.
 *
 * Returns null rather than an empty string when nothing usable survives: an
 * empty slug is not a slug, and silently substituting one would make every
 * unusable business name collide with every other.
 */

export const SLUG_MAX_LENGTH = 48;

/**
 * Names that would sit where a platform path already does, or that read as
 * infrastructure. Cheap to extend, expensive to retrofit once a tenant owns one.
 */
export const RESERVED_SLUGS = [
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "dashboard",
  "docs",
  "f",
  "graft",
  "help",
  "login",
  "logout",
  "me",
  "public",
  "settings",
  "signup",
  "static",
  "status",
  "support",
  "system",
  "webhooks",
  "www",
] as const;

const RESERVED = new Set<string>(RESERVED_SLUGS);

export function slugify(input: string): string | null {
  const slug = input
    // Decompose accents into base letter + combining mark, then drop the marks,
    // so "Café" becomes "cafe" rather than "caf".
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Apostrophes close up ("O'Shea" → "oshea"); everything else becomes a gap.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    // Truncation can land mid-gap, which would leave a trailing dash.
    .replace(/-+$/g, "");

  return slug.length ? slug : null;
}

export const isReservedSlug = (slug: string): boolean => RESERVED.has(slug.toLowerCase());
