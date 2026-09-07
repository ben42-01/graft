"use client";

/**
 * The authenticated app shell (AC1-AC3): nav, tenant switcher and user menu,
 * read from the `MeResponse` `SessionGate` already fetched — pure render, no
 * fetching, so it's testable without mocking `fetch`. Nav collapses into a
 * `Sheet` below `sm:` (AC2); the tenant's `branding.primaryColor` (AC3) is
 * applied as a CSS var and used only as a thin accent, never a full-panel
 * background, so a tenant's brand colour can't produce an unreadable pair.
 *
 * The 2026-08-21 UI refinement swapped the rail's plain "Graft" text for the
 * real lockup (`@/components/brand/graft-logo`) and gave the rail the same
 * faint green wash the landing and auth pages carry, so an authenticated
 * screen is recognisably the same product as the page the user signed up on.
 * A tenant's own `primaryColor` still wins where it is set — it overrides the
 * rail's top border, which is the one brand-accent slot the shell has.
 */
import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { GraftLockup, GraftMark } from "@/components/brand/graft-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Nav } from "@/components/shell/nav";
import { TenantSwitcher } from "@/components/shell/tenant-switcher";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { UserMenu } from "@/components/shell/user-menu";
import type { MeResponse } from "@/lib/session";

export function AppShell({
  me,
  onSwitchTenant,
  onLogOut,
  children,
}: {
  me: MeResponse;
  onSwitchTenant: (tenantId: string) => Promise<void>;
  onLogOut: () => Promise<void>;
  children: ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const accentColor = me.tenant.branding?.primaryColor ?? undefined;

  return (
    <div
      className="flex min-h-screen w-full overflow-x-hidden bg-background text-foreground"
      style={
        accentColor
          ? ({ "--graft-tenant-accent": accentColor } as React.CSSProperties)
          : undefined
      }
    >
      <aside
        className="hidden w-56 shrink-0 flex-col border-r border-border bg-graft-green/[0.03] p-4 sm:flex"
        style={
          accentColor
            ? { borderTopColor: "var(--graft-tenant-accent)", borderTopWidth: 3 }
            : { borderTopColor: "var(--color-graft-green)", borderTopWidth: 3 }
        }
      >
        <Link href="/home" aria-label="Graft home" className="mb-6 flex px-3">
          <GraftLockup className="h-7" />
        </Link>
        <Nav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="sm:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <MenuIcon className="size-4" />
          </Button>

          {/* The rail's lockup is hidden below `sm:`, so the mark stands in
           * for it — without one, the mobile header carries no brand at all. */}
          <Link href="/home" aria-label="Graft home" className="flex sm:hidden">
            <GraftMark className="size-6" />
          </Link>

          <div className="min-w-0 flex-1">
            <TenantSwitcher
              activeTenantId={me.tenant.id}
              memberships={me.memberships}
              onSwitch={onSwitchTenant}
            />
          </div>

          <ThemeToggle />
          <UserMenu me={me} onLogOut={onLogOut} />
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden p-4">{children}</main>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="sm:hidden">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <GraftMark className="size-5" />
              Navigation
            </SheetTitle>
          </SheetHeader>
          <div className="px-4">
            <Nav onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
