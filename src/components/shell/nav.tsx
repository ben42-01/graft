import Link from "next/link";
import { LayoutDashboardIcon, LayoutGridIcon } from "lucide-react";

/**
 * Primary nav links. Shared between the desktop rail and the mobile `Sheet`
 * (AC2) so the two never drift. "Dashboards" is GRAFT-13's widget composer;
 * the record-list route belongs to its own contract (GRAFT-12).
 */
const NAV_ITEMS = [
  { href: "/", label: "Home", icon: LayoutDashboardIcon },
  { href: "/dashboards", label: "Dashboards", icon: LayoutGridIcon },
] as const;

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
