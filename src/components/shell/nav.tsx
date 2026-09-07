"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpenIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Primary nav links. Shared between the desktop rail and the mobile `Sheet`
 * (AC2) so the two never drift. "Dashboards" is GRAFT-13's widget composer;
 * the record-list route belongs to its own contract (GRAFT-12).
 *
 * "Account" was added in the 2026-08-21 UI refinement: the tier gates
 * (Chart widget, "Add entity") told Free users to upgrade while the only
 * checkout button in the product lived on the *public* landing page — so an
 * authenticated user had nowhere in the app to act on the prompt.
 *
 * "Entities" and "Guide" followed, for a related reason: entities could be
 * created but never opened, edited or filled with records, and nothing
 * anywhere explained how the pieces fit. Order matters here — it is the
 * order the product is used in (define a shape, fill it, read it back).
 */
const NAV_ITEMS = [
  { href: "/home", label: "Home", icon: LayoutDashboardIcon },
  { href: "/entities", label: "Entities", icon: DatabaseIcon },
  { href: "/forms", label: "Forms", icon: FileTextIcon },
  { href: "/dashboards", label: "Dashboards", icon: LayoutGridIcon },
  { href: "/guide", label: "Guide", icon: BookOpenIcon },
  { href: "/account", label: "Account", icon: CreditCardIcon },
] as const;

export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        // Prefix match so `/dashboards/:id` still highlights "Dashboards".
        const active = pathname === href || pathname?.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-graft-green/10 text-graft-green dark:text-graft-green-light"
                : "text-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
