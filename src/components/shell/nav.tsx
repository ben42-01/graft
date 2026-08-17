import Link from "next/link";
import { LayoutDashboardIcon } from "lucide-react";

/**
 * Primary nav links. Just "Home" for now — the record-list/dashboard routes
 * belong to their own contracts (GRAFT-12/13). Shared between the desktop
 * rail and the mobile `Sheet` (AC2) so the two never drift.
 */
const NAV_ITEMS = [{ href: "/", label: "Home", icon: LayoutDashboardIcon }] as const;

export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
