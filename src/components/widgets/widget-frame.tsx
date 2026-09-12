/**
 * The chrome every widget shares — a fixed header strip and a scrolling body
 * that fills whatever footprint `sizes.ts` gave the card.
 *
 * Before this, each widget reached for `Card`/`CardHeader`/`CardTitle`
 * itself, with the stock `py-6 gap-6` padding. Four widgets meant four
 * slightly different headers, and a card whose content was shorter than its
 * grid cell floated in it while a taller one overflowed. Centralising the
 * frame is what makes "add a fifth widget type" a safe operation: the new
 * type declares a size and renders a body, and it lines up with the rest by
 * construction rather than by whoever wrote it matching the padding.
 *
 * `h-full` + `min-h-0` + `overflow-auto` is the load-bearing part: the card
 * fills its cell exactly, and content that doesn't fit scrolls inside the
 * card instead of pushing the grid row taller.
 */
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function WidgetFrame({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("h-full gap-0 overflow-hidden py-0", className)}>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-4">
        <p className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </p>
        {action}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-auto px-4 py-3", bodyClassName)}>
        {children}
      </div>
    </Card>
  );
}
