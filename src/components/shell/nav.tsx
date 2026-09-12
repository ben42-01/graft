"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BlocksIcon,
  BookOpenIcon,
  ExternalLinkIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileTextIcon,
  KanbanIcon,
  LayoutDashboardIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Primary nav links. Shared between the desktop rail and the mobile `Sheet`
 * (AC2) so the two never drift.
 *
 * 2026-09-11 — "Dashboards" left the rail. It used to sit here beside "Home"
 * and "Operations", which gave the product three top-level things all calling
 * themselves a dashboard and made the build-your-own one look mandatory.
 * `/home` is now the default Overview and the composer is reached from it
 * ("Custom views"), which is the relationship they actually have: one is the
 * product, the other is an option. The route itself is unchanged.
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
 *
 * 2026-09-12 — "Guide" opens in a new tab. It is the one entry here nobody
 * navigates *to*: it is read while doing something else, and a same-tab jump
 * threw away whatever half-built entity or form prompted the question. The
 * rest of the rail stays same-tab, because those are destinations rather
 * than references.
 */
type NavItem = {
  href: string;
  label: string;
  icon: typeof BookOpenIcon;
  /** Opens in a new tab — reference material, not a destination. */
  newTab?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/home", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/entities", label: "Entities", icon: DatabaseIcon },
  { href: "/forms", label: "Forms", icon: FileTextIcon },
  // The BMS operational layer (docs/BMS_EXTENSION.md §2.3). Sits after the
  // things it is built on — an operations board with no resources and no
  // orders has nothing to show.
  { href: "/operations", label: "Operations", icon: KanbanIcon },
  // `/api/v1/plugins/*` shipped in GRAFT-14 with no screen over it, which read
  // as a broken product rather than an unfinished one: a tenant could be told
  // their plan includes every plugin and have nowhere to turn one on.
  { href: "/plugins", label: "Plugins", icon: BlocksIcon },
  { href: "/guide", label: "Guide", icon: BookOpenIcon, newTab: true },
  { href: "/account", label: "Account", icon: CreditCardIcon },
];

export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon, newTab }) => {
        // Prefix match so `/dashboards/:id` still highlights "Dashboards".
        const active = pathname === href || pathname?.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            // A new tab leaves this one where it was, so the sheet that opened
            // it should not close underneath the user.
            onClick={newTab ? undefined : onNavigate}
            {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
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
            {newTab ? (
              <>
                <ExternalLinkIcon className="size-3 opacity-50" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
