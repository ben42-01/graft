/**
 * GRAFT-18 — the public route group's layout: everything here sits outside
 * `SessionGate` (`src/app/(app)/layout.tsx`), so it renders for anonymous
 * visitors without waiting on `/me`. Deliberately bare-bones (Constraints):
 * visual polish of the marketing shell is GRAFT-19's concern, this group
 * only needs the auth forms to be usable.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
