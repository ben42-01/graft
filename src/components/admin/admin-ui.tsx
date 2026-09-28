"use client";

/**
 * Presentational pieces shared by the admin console's screens. Kept to what
 * three or more screens actually use; anything one screen needs lives in that
 * screen. All colour comes from theme tokens (globals.css), so every piece
 * follows the light/dark toggle.
 */
import Link from "next/link";
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function RefreshButton({
  onClick,
  refreshing,
}: {
  onClick: () => void;
  refreshing?: boolean;
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={refreshing}>
      <RefreshCwIcon
        className={cn("size-4", refreshing && "animate-spin")}
        aria-hidden="true"
      />
      Refresh
    </Button>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border bg-card p-5",
        className,
      )}
    >
      {title || action ? (
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
            {description ? (
              <p className="text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

const nf = new Intl.NumberFormat();
export const formatNumber = (value: number): string => nf.format(value);

export function StatTile({
  label,
  value,
  hint,
  href,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  href?: string;
  icon?: typeof CopyIcon;
  tone?: "default" | "warning" | "critical";
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {Icon ? (
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-md bg-graft-green/10 text-graft-green dark:text-graft-green-light",
              tone === "warning" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
              tone === "critical" && "bg-destructive/10 text-destructive",
            )}
            aria-hidden="true"
          >
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <span className="text-3xl font-semibold tracking-tight">
        {typeof value === "number" ? formatNumber(value) : value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </>
  );
  const className =
    "flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4 transition-colors";
  return href ? (
    <Link
      href={href}
      className={cn(className, "hover:border-graft-green/50 hover:bg-graft-green/[0.03]")}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

type PillTone = "neutral" | "green" | "blue" | "amber" | "red" | "indigo";

const PILL_TONES: Record<PillTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  green: "bg-graft-green/10 text-graft-green-deep dark:text-graft-green-light",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  amber: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  red: "bg-destructive/10 text-destructive",
  indigo: "bg-graft-indigo/10 text-graft-indigo dark:text-indigo-300",
};

export function Pill({
  tone = "neutral",
  className,
  children,
}: {
  tone?: PillTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        PILL_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const TIER_TONE: Record<string, PillTone> = {
  free: "neutral",
  premium: "green",
  enterprise: "indigo",
};

export function TierPill({ tier }: { tier: string }) {
  // Capitalised by CSS, not by string: the text stays the tier's own value.
  return (
    <Pill tone={TIER_TONE[tier] ?? "neutral"} className="capitalize">
      {tier}
    </Pill>
  );
}

export function OutcomePill({ ok }: { ok: boolean }) {
  return ok ? <Pill tone="green">✓ Succeeded</Pill> : <Pill tone="red">✕ Failed</Pill>;
}

/** Table chrome shared by every admin list — header row, hover, dividers. */
export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-left text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-border [&_tbody_tr:hover]:bg-muted/40 [&_tbody_tr:last-child]:border-b-0 [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:tracking-wide [&_th]:text-muted-foreground [&_th]:uppercase [&_thead]:border-b [&_thead]:border-border [&_thead]:bg-muted/40">
        {children}
      </table>
    </div>
  );
}

/** Loading / error / empty wrapper so every list reads the same while it waits. */
export function ListBody({
  status,
  error,
  empty,
  count,
  label,
  onRetry,
  children,
}: {
  status: "loading" | "error" | "ready";
  error?: string;
  empty: { title: string; description: string };
  count: number;
  label: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (status === "loading" && count === 0)
    return <LoadingState label={`Loading ${label}…`} variant="list" />;
  if (status === "error")
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorState
          title={`Couldn't load ${label}`}
          description={error ?? "Please try again."}
        />
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  if (count === 0) return <EmptyState title={empty.title} description={empty.description} />;
  return (
    <div className={cn(status === "loading" && "opacity-60 transition-opacity")}>
      {children}
    </div>
  );
}

export function LoadMore({
  hasMore,
  loading,
  onClick,
  shown,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  shown: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>
        Showing {formatNumber(shown)}
        {hasMore ? "+" : ""}
      </span>
      {hasMore ? (
        <Button type="button" variant="outline" size="sm" loading={loading} onClick={onClick}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 hours ago" / "in 2 days" — the absolute time rides along as a tooltip. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return Math.abs(seconds) < 30 ? "just now" : rtf.format(seconds, "second");
}

export function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="whitespace-nowrap">
      {relativeTime(iso)}
    </time>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    </Button>
  );
}

/** A shortened id with a copy button — ids are for pasting, not reading. */
export function IdChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-xs text-muted-foreground">
      <span title={id}>{id.slice(-8)}</span>
      <CopyButton value={id} label="Copy id" />
    </span>
  );
}

/** A segmented control for small, mutually exclusive filters. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
