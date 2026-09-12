"use client";

/**
 * The other half of "a default dashboard you don't have to build".
 *
 * A brand-new tenant has no orders, no allocations and no records, so every
 * panel above this one would honestly read "nothing yet" — which is accurate
 * and useless. This turns that emptiness into the one thing that *is*
 * actionable on day one: the path through the product, in the order the
 * product is used in, with each step's done-ness derived from real data
 * rather than a stored "onboarding step" flag that can drift from reality.
 *
 * It disappears once the steps are done. A permanent checklist on the landing
 * screen is a permanent reminder that the product is unfinished.
 *
 * A step has three states, not two. If the read a step depends on failed —
 * `/api/v1/forms` currently 500s against seeded dev data, for one — then the
 * honest answer is "couldn't check", not "you haven't done this". Telling
 * someone to go publish the form they already published is worse than saying
 * nothing, so `null` counts render as unknown and are never the step the
 * checklist points at next.
 */
import Link from "next/link";
import { CheckIcon, CircleIcon, HelpCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SetupStepStatus = "done" | "todo" | "unknown";

export type SetupStep = {
  id: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  status: SetupStepStatus;
};

/** `null` is "the read that would answer this failed", not zero. */
type Count = number | null;

const statusOf = (count: Count): SetupStepStatus =>
  count === null ? "unknown" : count > 0 ? "done" : "todo";

/**
 * Derived, never stored. Each step asks the data a question it can already
 * answer — "does this tenant have an entity?" — so a tenant who set something
 * up through the API, or had it seeded, is never told to go do it again.
 */
export function buildSetupSteps(input: {
  entityCount: Count;
  recordCount: Count;
  formCount: Count;
  orderCount: Count;
}): SetupStep[] {
  return [
    {
      id: "entity",
      title: "Define what you track",
      description:
        "Customers, jobs, bookable items — entities are the shapes your business runs on.",
      href: "/entities/templates",
      cta: "Start from a template",
      status: statusOf(input.entityCount),
    },
    {
      id: "record",
      title: "Add your first records",
      description: "Fill an entity with the real thing — your actual customers and stock.",
      href: "/entities",
      cta: "Open entities",
      status: statusOf(input.recordCount),
    },
    {
      id: "form",
      title: "Publish a customer form",
      description:
        "A public form is how enquiries and bookings arrive without anyone retyping them.",
      href: "/forms",
      cta: "Build a form",
      status: statusOf(input.formCount),
    },
    {
      id: "order",
      title: "Run your first order",
      description: "Orders tie a customer, a resource and a payment into one thing to manage.",
      href: "/operations",
      cta: "Open operations",
      status: statusOf(input.orderCount),
    },
  ];
}

/** True when at least one step is genuinely outstanding — an unknown step is
 * not a reason to keep nagging someone who may well be finished. */
export function hasOutstandingStep(steps: SetupStep[]): boolean {
  return steps.some((step) => step.status === "todo");
}

export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  // The first thing genuinely not done is the only step with a button. A
  // column of four equally-weighted calls to action is a menu, not a path.
  const next = steps.find((step) => step.status === "todo");
  const doneCount = steps.filter((step) => step.status === "done").length;
  const unknownCount = steps.filter((step) => step.status === "unknown").length;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Getting set up</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {doneCount} of {steps.length - unknownCount} done
        </p>
      </div>

      <ol className="mt-3 flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                step.status === "done"
                  ? "border-graft-green bg-graft-green text-white"
                  : "border-dashed text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {step.status === "done" ? (
                <CheckIcon className="size-3" />
              ) : step.status === "unknown" ? (
                <HelpCircleIcon className="size-3" />
              ) : (
                <CircleIcon className="size-1.5 fill-current" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm font-medium",
                  step.status === "done"
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                <span className="sr-only">
                  {step.status === "done"
                    ? "Done: "
                    : step.status === "unknown"
                      ? "Couldn't check: "
                      : "To do: "}
                </span>
                {step.title}
              </p>
              {step.status === "todo" ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
              ) : null}
              {step.status === "unknown" ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  We couldn&apos;t check this one just now.
                </p>
              ) : null}
              {step === next ? (
                <Button asChild size="sm" className="mt-2">
                  <Link href={step.href}>{step.cta}</Link>
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
