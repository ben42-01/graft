/**
 * AC2 — an unrecognised widget `type` renders this instead of crashing the
 * dashboard. Stored config is never inspected here; there is nothing safe to
 * assume about the shape of a type this build has never heard of.
 */
import { PuzzleIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { WidgetProps } from "@/lib/widgets/registry";

export function UnknownWidget({ widget }: WidgetProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
        <PuzzleIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">Unsupported widget</p>
        <p className="text-xs text-muted-foreground">
          Type &ldquo;{widget.type}&rdquo; is not recognised by this app version.
        </p>
      </CardContent>
    </Card>
  );
}
