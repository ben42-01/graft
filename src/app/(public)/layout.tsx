/**
 * GRAFT-18 — the public route group's layout: everything here sits outside
 * `SessionGate` (`src/app/(app)/layout.tsx`), so it renders for anonymous
 * visitors without waiting on `/me`.
 *
 * Deliberately just a full-height background: this group now spans both the
 * narrow auth forms (`/login`, `/signup`, `/billing/success`,
 * `/billing/cancel`) and the full-width marketing/pricing root (GRAFT-19,
 * `page.tsx`), which can't share one fixed `max-w-sm` centering wrapper.
 * Each narrow page brings its own centering container instead.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
