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
      className="inline-block text-xs text-muted-foreground hover:text-foreground"
    >
      Powered by Graft
    </a>
  );
}
