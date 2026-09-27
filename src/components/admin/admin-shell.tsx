"use client";

/**
 * The platform-admin console's chrome: a Graft-branded sidebar grouped by
 * what an operator is looking for (customers, product usage, monitoring,
 * developer tools), a slim top bar with the ⌘K jump and theme toggle, and a
 * mobile sheet carrying the same nav.
 *
 * Deliberately *not* the tenant `AppShell` (see src/app/(admin)/admin/layout.tsx
 * for why the two must never converge): no tenant switcher, no tier badge, no
 * upgrade prompts — an admin looking across every tenant is in no tenant.
 * The indigo "Admin" mark next to the lockup is there so the two shells cannot
 * be mistaken for each other at a glance.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeftIcon, LogOutIcon, MenuIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { GraftLockup, GraftMark } from "@/components/brand/graft-logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ADMIN_NAV, isActive } from "./admin-nav";
import { CommandPalette } from "./command-palette";

function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex flex-col gap-5">
      {ADMIN_NAV.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active = isActive(item, pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-graft-green/10 text-graft-green-deep dark:text-graft-green-light"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {active ? (
                  <span
                    className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-graft-green"
                    aria-hidden="true"
                  />
                ) : null}
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function AdminBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-graft-indigo/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-graft-indigo uppercase dark:text-indigo-300">
      <ShieldCheckIcon className="size-3" aria-hidden="true" />
      Admin
    </span>
  );
}

export function AdminShell({ email, children }: { email: string; children: ReactNode }) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const logOut = async () => {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" }).catch(
      () => {},
    );
    router.replace("/login");
  };

  const footer = (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <Link
        href="/home"
        className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to the app
      </Link>
      <div className="flex items-center gap-2 px-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-graft-green/15 text-xs font-semibold text-graft-green-deep uppercase dark:text-graft-green-light">
          {email.charAt(0) || "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={email}>
          {email}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void logOut()}
        >
          <LogOutIcon className="size-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen w-full bg-muted/30 text-foreground">
      <aside
        className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-background p-4 lg:flex"
        style={{ borderTop: "3px solid var(--color-graft-green)" }}
      >
        <div className="flex flex-col gap-1.5 px-3">
          <Link href="/admin" aria-label="Admin dashboard" className="flex">
            <GraftLockup className="h-7" />
          </Link>
          <div className="flex items-center gap-2">
            <AdminBadge />
            <span className="text-xs text-muted-foreground">Platform admin</span>
          </div>
        </div>
        <div className="flex-1">
          <AdminNav />
        </div>
        {footer}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <MenuIcon className="size-4" />
          </Button>
          <Link
            href="/admin"
            aria-label="Admin dashboard"
            className="flex items-center gap-2 lg:hidden"
          >
            <GraftMark className="size-6" />
            <AdminBadge />
          </Link>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto flex h-9 w-full max-w-sm items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted lg:ml-0"
          >
            <SearchIcon className="size-4" aria-hidden="true" />
            <span className="flex-1 truncate text-left">Search accounts, users, pages…</span>
            <kbd className="hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] sm:inline">
              ⌘K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="flex flex-col gap-4 lg:hidden">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <GraftMark className="size-5" />
              Admin console
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4">
            <AdminNav onNavigate={() => setMobileOpen(false)} />
          </div>
          <div className="px-4 pb-4">{footer}</div>
        </SheetContent>
      </Sheet>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
