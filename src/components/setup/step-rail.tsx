"use client";

/**
 * The progress rail — where you are, what is behind you, what is left.
 *
 * It shows the steps of *this* run, which is why the list is short for a
 * plain list and long for bookings: a rail advertising steps the run will
 * never reach is the same lie as a checklist that never empties.
 *
 * Completed steps are clickable; steps ahead of the current one are not. The
 * run is a path — each step attaches something to what the previous one
 * created — so jumping ahead would only ever land on a screen that cannot do
 * its job yet.
 */
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SetupStepId, StepProgress } from "@/lib/setup/flow";

export function StepRail({
  steps,
  current,
  onSelect,
}: {
  steps: StepProgress[];
  current: SetupStepId;
  onSelect: (step: SetupStepId) => void;
}) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Setup steps">
      {steps.map((step) => {
        const active = step.id === current;
        const selectable = step.reachable && !active;

        return (
          <li key={step.id}>
            <button
              type="button"
              disabled={!selectable}
              aria-current={active ? "step" : undefined}
              onClick={() => onSelect(step.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                active && "bg-muted font-medium",
                selectable && "hover:bg-muted/60",
                !step.reachable && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums",
                  step.complete
                    ? "border-graft-green bg-graft-green text-white"
                    : active
                      ? "border-foreground"
                      : "border-dashed",
                )}
                aria-hidden="true"
              >
                {step.complete ? <CheckIcon className="size-3" /> : step.index + 1}
              </span>
              <span className="min-w-0 truncate">
                <span className="sr-only">
                  {step.complete ? "Done: " : step.reachable ? "" : "Not yet: "}
                </span>
                {step.copy.label}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
