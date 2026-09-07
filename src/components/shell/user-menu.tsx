"use client";

/**
 * The account panel (AC1): identity from `/me`, the settings surfaces, and
 * sign-out. Built on `Sheet`, not a dropdown-menu primitive — none shipped
 * in GRAFT-11.1-11.3 and adding one isn't this issue's scope.
 *
 * 2026-08-21 UI refinement — it used to hold an email and a "Log out"
 * button, which left the one place users look for "my settings" almost
 * empty. It is now a grouped panel in the shape people expect from a desktop
 * app's settings: who you are and what plan you are on, then the account
 * surfaces (General, Privacy & data), then appearance, then support. Each
 * row links to a real page — nothing here is a placeholder.
 *
 * Theme lives here as a three-way choice (Light / Dark / System) rather than
 * only in the header's two-way `ThemeToggle`, because "follow my OS" is not
 * reachable from a toggle that flips between two resolved values.
 */
import {
  BookOpenIcon,
  CreditCardIcon,
  LifeBuoyIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  ShieldCheckIcon,
  SunIcon,
  UserRoundIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { PRIVACY_CONTACT_EMAIL } from "@/lib/legal/privacy";
import { TIER_LABEL } from "@/lib/tier-copy";
import { cn } from "@/lib/utils";
import type { MeResponse } from "@/lib/session";

const SUPPORT_EMAIL = PRIVACY_CONTACT_EMAIL;

type Row = {
  href: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** External (mailto) rows navigate with a plain anchor, not `next/link`. */
  external?: boolean;
};

const ACCOUNT_ROWS: Row[] = [
  {
    href: "/account",
    label: "General",
    description: "Your plan, limits and billing",
    icon: CreditCardIcon,
  },
  {
    href: "/account/privacy",
    label: "Privacy & data",
    description: "What we hold, and export it",
    icon: ShieldCheckIcon,
  },
];

const SUPPORT_ROWS: Row[] = [
  {
    href: "/guide",
    label: "Getting started",
    description: "How entities, records and dashboards fit",
    icon: BookOpenIcon,
  },
  {
    href: `mailto:${SUPPORT_EMAIL}?subject=Graft support`,
    label: "Help & feedback",
    description: SUPPORT_EMAIL,
    icon: LifeBuoyIcon,
    external: true,
  },
];

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function MenuRow({ row, onNavigate }: { row: Row; onNavigate: () => void }) {
  const className =
    "flex items-start gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground";
  const content = (
    <>
      <row.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{row.label}</span>
        <span className="truncate text-xs text-muted-foreground">{row.description}</span>
      </span>
    </>
  );

  return row.external ? (
    <a href={row.href} className={className} onClick={onNavigate}>
      {content}
    </a>
  ) : (
    <Link href={row.href} className={className} onClick={onNavigate}>
      {content}
    </Link>
  );
}

function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  // next-themes only resolves client-side; render neutral until it has.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div role="group" aria-label="Theme" className="flex gap-1 rounded-md border p-1">
      {THEME_OPTIONS.map((option) => {
        const active = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setTheme(option.value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-graft-green/10 text-graft-green dark:text-graft-green-light"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <option.icon className="size-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function UserMenu({ me, onLogOut }: { me: MeResponse; onLogOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  const tier = me.tenant.tier as keyof typeof TIER_LABEL;
  const roles =
    me.memberships.find((membership) => membership.tenantId === me.tenant.id)?.roles ?? [];

  const handleLogOut = async () => {
    setSigningOut(true);
    try {
      await onLogOut();
      setOpen(false);
      router.replace("/login");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Open user menu">
          <UserRoundIcon className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Account</SheetTitle>
          <SheetDescription>{me.user.email}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4">
          {/* Which workspace these settings apply to — the switcher lives in
           * the header, so without this the panel is ambiguous in a
           * multi-workspace account. */}
          <div className="flex items-center justify-between gap-3 rounded-md border bg-graft-green/[0.03] p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{me.tenant.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {roles.length > 0 ? roles.join(", ") : "member"}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-graft-green/40 bg-graft-green/10 px-2 py-0.5 text-xs font-medium text-graft-green dark:text-graft-green-light">
              {TIER_LABEL[tier] ?? me.tenant.tier}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <SectionLabel>Settings</SectionLabel>
            {ACCOUNT_ROWS.map((row) => (
              <MenuRow key={row.href} row={row} onNavigate={() => setOpen(false)} />
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel>Appearance</SectionLabel>
            <ThemeChoice />
          </div>

          <div className="flex flex-col gap-1">
            <SectionLabel>Support</SectionLabel>
            {SUPPORT_ROWS.map((row) => (
              <MenuRow key={row.href} row={row} onNavigate={() => setOpen(false)} />
            ))}
            <MenuRow
              row={{
                href: "/privacy",
                label: "Privacy statement",
                description: "The public copy",
                icon: ShieldCheckIcon,
              }}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 p-4">
          <Button type="button" variant="outline" disabled={signingOut} onClick={handleLogOut}>
            <LogOutIcon className="size-4" />
            {signingOut ? "Signing out..." : "Log out"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
