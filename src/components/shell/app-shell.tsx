"use client";

/**
 * The authenticated app shell (AC1-AC3): nav, tenant switcher and user menu,
 * read from the `MeResponse` `SessionGate` already fetched — pure render, no
 * fetching, so it's testable without mocking `fetch`. Nav collapses into a
 * `Sheet` below `sm:` (AC2); the tenant's `branding.primaryColor` (AC3) is
 * applied as a CSS var and used only as a thin accent, never a full-panel
 * background, so a tenant's brand colour can't produce an unreadable pair.
 */
import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
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
        className="hidden w-56 shrink-0 border-r border-border p-4 sm:flex sm:flex-col"
        style={
          accentColor
            ? { borderTopColor: "var(--graft-tenant-accent)", borderTopWidth: 3 }
            : undefined
        }
      >
        <Link href="/" className="mb-6 px-3 text-sm font-semibold tracking-tight">
          Graft
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

          <div className="min-w-0 flex-1">
            <TenantSwitcher
              activeTenantId={me.tenant.id}
              memberships={me.memberships}
              onSwitch={onSwitchTenant}
            />
          </div>

          <ThemeToggle />
          <UserMenu email={me.user.email} onLogOut={onLogOut} />
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden p-4">{children}</main>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="sm:hidden">
          <SheetHeader>
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="px-4">
            <Nav onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
