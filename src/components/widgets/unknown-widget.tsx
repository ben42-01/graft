/**
 * AC2 — an unrecognised widget `type` renders this instead of crashing the
 * dashboard. Stored config is never inspected here; there is nothing safe to
 * assume about the shape of a type this build has never heard of.
 */
import { PuzzleIcon } from "lucide-react";
import { WidgetFrame } from "@/components/widgets/widget-frame";
import type { WidgetProps } from "@/lib/widgets/registry";

export function UnknownWidget({ widget }: WidgetProps) {
  return (
    <WidgetFrame
      title="Unsupported widget"
      className="border-dashed"
      bodyClassName="flex flex-col items-center justify-center gap-1.5 text-center"
    >
      <PuzzleIcon className="size-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">
        Type &ldquo;{widget.type}&rdquo; is not recognised by this app version.
      </p>
    </WidgetFrame>
  );
}
