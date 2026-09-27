import { GraftMark } from "@/components/brand/graft-logo";

/**
 * AC5 — present on Free, absent on Premium, decided server-side by
 * `shouldShowBadge` (public-form-page.ts) before this ever renders. No prop
 * lets a caller hide it client-side; the component either renders or it
 * isn't mounted at all.
 */
export function PoweredByBadge() {
  return (
    <a
      href="https://graft.app"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur hover:text-foreground"
    >
      <GraftMark className="size-4" />
      Powered by Graft
    </a>
  );
}
