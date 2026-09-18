"use client";

/**
 * Guided setup — the path from "we have nothing in here" to a published form
 * that takes real requests, in the order the product actually works.
 *
 * Why a guided path rather than better documentation: setting the same thing
 * up by hand hits five confusions, and every one of them is a sequencing or
 * visibility problem. Taking bookings needs two lists, not one. The record a
 * submission creates *is* the customer. Availability is computed, not stored,
 * so it is not a field. A pool attaches to a record, so it cannot be set
 * before records exist. And a field the engine never reads still looks
 * operational. Prose can describe all five; only an ordering can stop them
 * happening.
 *
 * The flow owns no data of its own. Every list, record, pool and form it
 * produces is created through the ordinary endpoints and is ordinary
 * afterwards — the run doc (`/api/v1/setup`) only remembers which step you
 * reached and what it pointed at. That is also why this page *reconciles* on
 * load: if the entity a run points at was deleted from `/entities` in another
 * tab, the run is repaired from what really exists rather than insisting.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { EntityStep } from "@/components/setup/entity-step";
import { FormStep, type CreatedForm } from "@/components/setup/form-step";
import { RecordsStep } from "@/components/setup/records-step";
import { StepRail } from "@/components/setup/step-rail";
import {
  blockingReason,
  currentStep,
  INTENT_COPY,
  nextStep,
  previousStep,
  progressFor,
  SETUP_INTENTS,
  stepCopy,
  type SetupIntent,
  type SetupRunState,
  type SetupStepId,
} from "@/lib/setup/flow";
import {
  requestEntityName,
  suggestedRequestFields,
  suggestedResourceFields,
} from "@/lib/setup/suggested-fields";
import type { FieldLike } from "@/lib/entities/record-values";
import { cn } from "@/lib/utils";

type EntityView = { id: string; name: string; fields: FieldLike[] };

type RunView = SetupRunState & { id: string; step: SetupStepId };

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "idle" } // nothing open — offer to start
  | { status: "ready"; run: RunView };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return null;
    return ((await response.json()) as { data: T }).data;
  } catch {
    return null;
  }
}

export default function SetupPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [step, setStep] = useState<SetupStepId>("thing");
  const [resource, setResource] = useState<EntityView | null>(null);
  const [request, setRequest] = useState<EntityView | null>(null);
  const [form, setForm] = useState<CreatedForm | null>(null);
  const [thingDraft, setThingDraft] = useState("");
  const [saving, setSaving] = useState(false);

  /** One PATCH per step outcome. The run merges, so a step only sends what it
   * just did and can never clear an answer given earlier. */
  const patchRun = useCallback(async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const response = await fetch("/api/v1/setup", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) return null;
      const run = ((await response.json()) as { data: RunView }).data;
      setState({ status: "ready", run });
      return run;
    } catch {
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  /**
   * Loads the run and checks it against reality. A pointer to something that
   * no longer exists is cleared rather than shown: a step claiming to have
   * created a list you deleted is worse than asking you to make it again.
   */
  const load = useCallback(async () => {
    const run = await getJson<RunView | null>("/api/v1/setup");
    if (run === null) {
      setState({ status: "idle" });
      return;
    }

    const [resourceEntity, requestEntity, formView] = await Promise.all([
      run.resourceEntityId
        ? getJson<EntityView>(`/api/v1/entities/${run.resourceEntityId}`)
        : null,
      run.requestEntityId
        ? getJson<EntityView>(`/api/v1/entities/${run.requestEntityId}`)
        : null,
      run.formId ? getJson<CreatedForm>(`/api/v1/forms/${run.formId}`) : null,
    ]);

    const repaired: RunView = {
      ...run,
      resourceEntityId: resourceEntity?.id ?? null,
      requestEntityId: requestEntity?.id ?? null,
      formId: formView?.id ?? null,
      formPublished: formView?.published ?? false,
      recordCount: resourceEntity ? run.recordCount : 0,
      bookableRecordCount: resourceEntity ? run.bookableRecordCount : 0,
    };

    setResource(resourceEntity);
    setRequest(requestEntity);
    setForm(formView);
    setThingDraft(run.thingLabel);
    setState({ status: "ready", run: repaired });
    setStep(currentStep(repaired));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startRun = useCallback(async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/v1/setup", { method: "POST", credentials: "include" });
      if (!response.ok) {
        setState({ status: "error" });
        return;
      }
      const run = ((await response.json()) as { data: RunView }).data;
      setResource(null);
      setRequest(null);
      setForm(null);
      setThingDraft("");
      setState({ status: "ready", run });
      setStep("thing");
    } finally {
      setSaving(false);
    }
  }, []);

  const onCounts = useCallback(
    (counts: { recordCount: number; bookableRecordCount: number }) => {
      setState((prev) =>
        prev.status === "ready" ? { status: "ready", run: { ...prev.run, ...counts } } : prev,
      );
      void patchRun(counts);
    },
    [patchRun],
  );

  if (state.status === "loading") return <LoadingState label="Loading setup…" />;
  if (state.status === "error") return <ErrorState description="We couldn't load setup." />;

  if (state.status === "idle") {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4 py-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Set something up</h1>
        <p className="text-sm text-muted-foreground">
          A few questions about one thing your business handles — whatever it is — and you come
          out with it listed, priced if you want, and a form people can actually use.
        </p>
        <div className="flex justify-center gap-3">
          <Button type="button" disabled={saving} onClick={() => void startRun()}>
            Start
          </Button>
          <Button asChild variant="outline">
            <Link href="/entities">Skip — I&apos;ll do it myself</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Run a hotel, salon, rental or similar?{" "}
          <Link
            href="/templates"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Set the whole business up from a template
          </Link>{" "}
          instead.
        </p>
      </div>
    );
  }

  const { run } = state;
  const steps = progressFor(run);
  const copy = stepCopy(step, run);
  const blocked = blockingReason(step, run);
  const back = previousStep(step, run);
  const forward = nextStep(step, run);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 md:flex-row md:gap-10">
      <aside className="md:w-48 md:shrink-0">
        <p className="mb-2 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Setting up
        </p>
        <StepRail steps={steps} current={step} onSelect={setStep} />
      </aside>

      <main className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">{copy.blurb}</p>

        {step === "thing" ? (
          <div className="flex max-w-sm flex-col gap-3">
            <Label htmlFor="setup-thing" className="text-xs">
              Call them what you call them
            </Label>
            <Input
              id="setup-thing"
              value={thingDraft}
              maxLength={120}
              placeholder="Boats, rooms, courses, tools…"
              onChange={(event) => setThingDraft(event.target.value)}
              onBlur={() => {
                if (thingDraft.trim() !== run.thingLabel) {
                  void patchRun({ thingLabel: thingDraft.trim(), step: "thing" });
                }
              }}
            />
          </div>
        ) : null}

        {step === "intent" ? (
          <div className="flex flex-col gap-3">
            {SETUP_INTENTS.map((intent) => (
              <button
                key={intent}
                type="button"
                onClick={() =>
                  void patchRun({ intent, step: "shape" }).then(() => setStep("shape"))
                }
                className={cn(
                  "rounded-lg border p-4 text-left hover:border-foreground/40",
                  run.intent === intent && "border-foreground",
                )}
              >
                <p className="text-sm font-medium">{INTENT_COPY[intent].label}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {INTENT_COPY[intent].blurb}
                </p>
              </button>
            ))}
          </div>
        ) : null}

        {step === "shape" ? (
          <EntityStep
            defaultName={run.thingLabel || "My list"}
            suggested={suggestedResourceFields(run.intent)}
            created={resource}
            onCreated={(entity) => {
              void getJson<EntityView>(`/api/v1/entities/${entity.id}`).then(setResource);
              void patchRun({ resourceEntityId: entity.id, step: "records" });
            }}
          />
        ) : null}

        {step === "records" && resource ? (
          <RecordsStep
            mode="add"
            entityId={resource.id}
            entityName={resource.name}
            fields={resource.fields}
            onCounts={onCounts}
          />
        ) : null}

        {step === "bookable" && resource ? (
          <RecordsStep
            mode="bookable"
            entityId={resource.id}
            entityName={resource.name}
            fields={resource.fields}
            onCounts={onCounts}
          />
        ) : null}

        {step === "request" ? (
          <EntityStep
            defaultName={requestEntityName(run.thingLabel)}
            suggested={suggestedRequestFields(run.intent)}
            created={request}
            onCreated={(entity) => {
              void getJson<EntityView>(`/api/v1/entities/${entity.id}`).then(setRequest);
              void patchRun({ requestEntityId: entity.id, step: "form" });
            }}
          />
        ) : null}

        {step === "form" && resource && request && run.intent ? (
          <FormStep
            intent={run.intent as SetupIntent}
            thingLabel={run.thingLabel}
            resourceEntityId={resource.id}
            resourceFields={resource.fields}
            requestEntityId={request.id}
            requestFields={request.fields}
            created={form}
            onCreated={(created) => {
              setForm(created);
              void patchRun({ formId: created.id, formPublished: created.published });
            }}
            onPublished={(published) => {
              setForm(published);
              void patchRun({ formPublished: true, step: "done" });
            }}
          />
        ) : null}

        {step === "done" ? (
          <DoneStep run={run} resource={resource} request={request} form={form} />
        ) : null}

        <div className="mt-8 flex items-center gap-3 border-t pt-4">
          {back ? (
            <Button type="button" variant="outline" onClick={() => setStep(back)}>
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              Back
            </Button>
          ) : null}

          {forward ? (
            <Button
              type="button"
              disabled={blocked !== null || saving}
              onClick={() => {
                setStep(forward);
                void patchRun({ step: forward });
              }}
            >
              Next
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                void patchRun({ completed: true, step: "done" }).then(() =>
                  setState({ status: "idle" }),
                );
              }}
            >
              Finish
            </Button>
          )}

          <p className="text-xs text-muted-foreground">{blocked ?? ""}</p>
        </div>
      </main>
    </div>
  );
}

/**
 * The closing screen. It names what the run built and where each piece lives
 * from now on, because the failure mode of a wizard is that it ends and the
 * user has no idea which of the product's screens they are now supposed to
 * use.
 */
function DoneStep({
  run,
  resource,
  request,
  form,
}: {
  run: SetupRunState;
  resource: EntityView | null;
  request: EntityView | null;
  form: CreatedForm | null;
}) {
  const built = [
    resource
      ? {
          href: `/entities/${resource.id}`,
          title: resource.name,
          detail: `${run.recordCount} added${
            run.bookableRecordCount > 0 ? `, ${run.bookableRecordCount} bookable` : ""
          }. Add more, or change the fields, here.`,
        }
      : null,
    request
      ? {
          href: `/entities/${request.id}`,
          title: request.name,
          detail: "Every request arrives here as a record. That record is the customer.",
        }
      : null,
    form
      ? {
          href: `/forms/${form.id}`,
          title: "Your form",
          detail: form.published
            ? "Live. Share the link, and submissions land in the list above."
            : "Not published yet — publish it from its page when you are ready.",
        }
      : null,
  ].filter((entry): entry is { href: string; title: string; detail: string } => entry !== null);

  return (
    <div className="flex flex-col gap-3">
      {built.map((entry) => (
        <Link
          key={entry.href}
          href={entry.href}
          className="rounded-lg border p-4 hover:border-foreground/40"
        >
          <p className="text-sm font-medium">{entry.title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{entry.detail}</p>
        </Link>
      ))}
      <p className="text-xs text-muted-foreground">
        Orders and allocations show up under{" "}
        <Link href="/operations" className="underline underline-offset-4">
          Operations
        </Link>{" "}
        as requests come in.
      </p>
    </div>
  );
}
