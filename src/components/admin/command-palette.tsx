"use client";

/**
 * ⌘K / Ctrl+K quick jump for the admin console: every section, plus live
 * search over accounts (by name/slug) and users (by email/name) through the
 * same admin list endpoints the screens use — so it is gated and audited
 * exactly like them. Arrow keys move, Enter opens, Esc closes.
 */
import { useRouter } from "next/navigation";
import { BlocksIcon, SearchIcon, UserIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { adminGet, useDebounced } from "./admin-api";
import { ADMIN_NAV_ITEMS } from "./admin-nav";

type Result = {
  key: string;
  href: string;
  label: string;
  hint: string;
  icon: typeof SearchIcon;
  group: string;
};

type TenantHit = { id: string; name: string; slug: string; tier: string };
type UserHit = { id: string; email: string; name: string | null };

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const query = useDebounced(text, 200);
  const [remote, setRemote] = useState<Result[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) {
      setText("");
      setRemote([]);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || query.length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    void Promise.allSettled([
      adminGet<TenantHit[]>("/api/v1/admin/tenants", { q: query, limit: "5" }),
      adminGet<UserHit[]>("/api/v1/admin/users", { q: query, limit: "5" }),
    ]).then(([tenants, users]) => {
      if (cancelled) return;
      const out: Result[] = [];
      if (tenants.status === "fulfilled")
        for (const t of tenants.value.data)
          out.push({
            key: `t-${t.id}`,
            href: `/admin/tenants/${t.id}`,
            label: t.name || "(unnamed)",
            hint: `${t.slug} · ${t.tier}`,
            icon: BlocksIcon,
            group: "Accounts",
          });
      if (users.status === "fulfilled")
        for (const u of users.value.data)
          out.push({
            key: `u-${u.id}`,
            href: `/admin/users?q=${encodeURIComponent(u.email)}`,
            label: u.email,
            hint: u.name ?? "",
            icon: UserIcon,
            group: "Users",
          });
      setRemote(out);
    });
    return () => {
      cancelled = true;
    };
  }, [open, query]);

  const results = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const pages: Result[] = ADMIN_NAV_ITEMS.filter(
      (item) =>
        !needle ||
        item.label.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle),
    ).map((item) => ({
      key: item.href,
      href: item.href,
      label: item.label,
      hint: item.description,
      icon: item.icon,
      group: "Go to",
    }));
    return [...pages, ...remote];
  }, [text, remote]);

  useEffect(() => setActive(0), [results.length]);

  const go = (result: Result | undefined) => {
    if (!result) return;
    onOpenChange(false);
    router.push(result.href);
  };

  let lastGroup = "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <SearchIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(results[active]);
              }
            }}
            placeholder="Jump to a page, or search accounts and users…"
            aria-label="Search the admin console"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <ul role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</li>
          ) : null}
          {results.map((result, index) => {
            const header = result.group !== lastGroup ? result.group : null;
            lastGroup = result.group;
            const Icon = result.icon;
            return (
              <li key={result.key} role="none">
                {header ? (
                  <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    {header}
                  </p>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(result)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                    index === active &&
                      "bg-graft-green/10 text-graft-green-deep dark:text-graft-green-light",
                  )}
                >
                  <Icon className="size-4 shrink-0 opacity-70" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-medium">{result.label}</span>
                  <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                    {result.hint}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
