"use client";

/**
 * One number on the Overview's headline strip.
 *
 * Every tile is the same height and the same internal rhythm — label, value,
 * hint — because a row of stats is read by scanning down the values, and that
 * only works if the values sit on one line. This is the same discipline
 * `WidgetFrame` applies to dashboard widgets, kept separate because a stat
 * tile is not a widget: it has no config, no registry entry, and nothing to
 * fetch of its own. The Overview hands it a number it already has.
 *
 * A tile with an `href` is a doorway — the whole card is the link, because a
 * number the reader can act on should not make them hunt for where.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "warn" | "danger";

const TONE_CLASS: Record<StatTone, string> = {
  default: "text-foreground",
  warn: "text-graft-warn",
  danger: "text-destructive",
};

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  href,
  loading = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <>
      <p className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 text-2xl font-semibold tabular-nums",
          loading ? "text-muted-foreground" : TONE_CLASS[tone],
        )}
      >
        {/* An em dash, never "0" — a reading that failed to load and a reading
         * of zero are different facts, and conflating them is how a dashboard
         * quietly lies. */}
        {loading ? "…" : value}
      </p>
      {hint ? <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );

  const className = "relative h-full justify-center gap-0 px-4 py-4";

  if (!href) return <Card className={className}>{body}</Card>;

  return (
    <Card
      className={cn(
        className,
        "transition-colors hover:border-graft-green/40 hover:bg-accent/40",
      )}
    >
      <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-none">
        {body}
      </Link>
    </Card>
  );
}
