"use client";

/**
 * Setting a workspace up from a business template — four plain questions and
 * one click.
 *
 *   1. **How you work** — the template's toggles ("Let guests book dates
 *      online?") and its optional extras, each marked if it would not fit
 *      what the plan has left.
 *   2. **Names & details** — what you call things ("Rooms" → "Cabins") and
 *      which optional fields you want.
 *   3. **Money & terms** — deposit, Stripe payment link, terms page, sample
 *      data, publish now or later.
 *   4. **Review** — exactly what will be created, priced against the plan,
 *      from the same resolver the server applies.
 *
 * The blueprint is resolved locally on every change, so a bad answer is
 * reported where it was typed; the server preview adds what only the server
 * knows (remaining allowance, names already taken). Apply is resumable: if
 * it fails part-way, "Try again" continues the same run rather than building
 * a second copy.
 */
import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  LockIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  fillNouns,
  findWorkspaceTemplate,
  resolveTemplate,
  TemplateAnswerError,
  type PlanRequirements,
  type TemplateAnswersInput,
  type WorkspacePlan,
  type WorkspaceTemplate,
} from "@/lib/workspace-templates";

const STEPS = [
  { id: "decisions", label: "How you work" },
  { id: "names", label: "Names & details" },
  { id: "money", label: "Money & terms" },
  { id: "review", label: "Review" },
] as const;

type StepId = (typeof STEPS)[number]["id"] | "done";

type Allowance = Record<keyof PlanRequirements, number | null>;

type Preview = {
  plan: WorkspacePlan;
  requirements: PlanRequirements;
  allowance: Allowance;
  fits: boolean;
  modules: { id: string; selected: boolean; fits: boolean }[];
  renamed: { kind: "entity" | "form"; from: string; to: string }[];
};

type Applied = {
  runId: string;
  entities: { ref: string; id: string; key: string; name: string }[];
  forms: {
    ref: string;
    id: string;
    name: string;
    visibility: "internal" | "public";
    publicSlug: string | null;
    takesBookings: boolean;
  }[];
  records: number;
  pools: number;
};

type ApiError = { code: string; message: string; details?: Record<string, unknown> };

async function post<T>(url: string, body: unknown): Promise<{ data: T } | { error: ApiError }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as
      { data: T } | { error: ApiError } | null;
    if (!json) return { error: { code: "INTERNAL", message: "Something went wrong." } };
    return json;
  } catch {
    return { error: { code: "NETWORK", message: "Network error. Try again." } };
  }
}

const METER_LABEL: Record<keyof PlanRequirements, string> = {
  entities: "Lists",
  records: "Records",
  internal_forms: "Staff forms",
  active_forms: "Published forms",
};

export default function WorkspaceTemplateWizard({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = use(params);
  const template = findWorkspaceTemplate(templateId);
  if (!template) notFound();
  return <Wizard template={template} />;
}

function Wizard({ template }: { template: WorkspaceTemplate }) {
  const [step, setStep] = useState<StepId>("decisions");
  const [answers, setAnswers] = useState<TemplateAnswersInput>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ApiError | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);

  const patch = (next: Partial<TemplateAnswersInput>) =>
    setAnswers((previous) => ({ ...previous, ...next }));

  // Resolved locally on every keystroke — the same function the server runs.
  const local = useMemo(() => {
    try {
      return { plan: resolveTemplate(template, answers), error: null };
    } catch (error) {
      if (error instanceof TemplateAnswerError) return { plan: null, error };
      throw error;
    }
  }, [template, answers]);

  // What the owner could still switch on: the plan without anything omitted.
  const fullPlan = useMemo(() => {
    try {
      return resolveTemplate(template, {
        ...answers,
        omitFields: [],
        paymentLink: null,
        termsUrl: null,
      });
    } catch {
      return null;
    }
  }, [template, answers]);

  // The server's view — allowance and names in use — refreshed as answers settle.
  useEffect(() => {
    if (!local.plan || step === "done") return;
    const timer = setTimeout(async () => {
      const result = await post<Preview>(`/api/v1/workspace-templates/${template.id}/preview`, {
        answers,
      });
      if ("data" in result) {
        setPreview(result.data);
        setPreviewError(null);
      } else {
        setPreviewError(result.error.message);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [template.id, answers, local.plan, step]);

  const nouns = new Map(
    template.nouns.map((noun) => [noun.id, answers.nouns?.[noun.id] ?? noun]),
  );
  const fill = (text: string) => fillNouns(text, nouns);

  async function apply() {
    setApplying(true);
    setApplyError(null);
    const result = await post<Applied>(
      `/api/v1/workspace-templates/${template.id}/apply`,
      runId ? { runId } : { answers },
    );
    setApplying(false);
    if ("data" in result) {
      setApplied(result.data);
      setStep("done");
      return;
    }
    const failedRun = result.error.details?.runId;
    if (typeof failedRun === "string") setRunId(failedRun);
    setApplyError(result.error);
  }

  const stepIndex = STEPS.findIndex((candidate) => candidate.id === step);
  const next = STEPS[stepIndex + 1]?.id;
  const back = STEPS[stepIndex - 1]?.id;

  if (step === "done" && applied) return <Done template={template} applied={applied} />;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 md:flex-row md:gap-10">
      <aside className="md:w-52 md:shrink-0">
        <Link
          href="/templates"
          className="px-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; All templates
        </Link>
        <p className="mt-3 mb-2 flex items-center gap-2 px-2 text-sm font-medium">
          <span aria-hidden="true">{template.icon}</span> {template.name}
        </p>
        <ol className="flex flex-col gap-1" aria-label="Setup steps">
          {STEPS.map((candidate, index) => {
            const active = candidate.id === step;
            const reachable = index <= stepIndex || (index === stepIndex + 1 && local.plan);
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  disabled={!reachable || active || runId !== null}
                  aria-current={active ? "step" : undefined}
                  onClick={() => setStep(candidate.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                    active && "bg-muted font-medium",
                    !active && reachable && "hover:bg-muted/60",
                    !reachable && "text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums",
                      index < stepIndex
                        ? "border-graft-green bg-graft-green text-white"
                        : active
                          ? "border-foreground"
                          : "border-dashed",
                    )}
                    aria-hidden="true"
                  >
                    {index < stepIndex ? <CheckIcon className="size-3" /> : index + 1}
                  </span>
                  {candidate.label}
                </button>
              </li>
            );
          })}
        </ol>
      </aside>

      <main className="min-w-0 flex-1">
        {step === "decisions" ? (
          <DecisionsStep
            template={template}
            answers={answers}
            patch={patch}
            preview={preview}
          />
        ) : null}
        {step === "names" ? (
          <NamesStep
            template={template}
            answers={answers}
            patch={patch}
            fullPlan={fullPlan}
            fill={fill}
          />
        ) : null}
        {step === "money" ? (
          <MoneyStep
            template={template}
            answers={answers}
            patch={patch}
            plan={fullPlan}
            fill={fill}
          />
        ) : null}
        {step === "review" ? (
          <ReviewStep preview={preview} error={previewError} localPlan={local.plan} />
        ) : null}

        {local.error ? (
          <p role="alert" className="mt-6 text-sm text-destructive">
            {local.error.message}
          </p>
        ) : null}

        {applyError ? (
          <p role="alert" className="mt-6 text-sm text-destructive">
            {applyError.message}{" "}
            {applyError.code === "QUOTA_EXCEEDED" ? (
              <Link href="/account" className="font-medium underline underline-offset-4">
                View plans
              </Link>
            ) : runId ? (
              "Anything already created is kept — trying again carries on from where it stopped."
            ) : null}
          </p>
        ) : null}

        <div className="mt-8 flex items-center justify-between gap-3 border-t pt-6">
          {back && runId === null ? (
            <Button type="button" variant="ghost" onClick={() => setStep(back)}>
              <ArrowLeftIcon /> Back
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button type="button" disabled={!local.plan} onClick={() => setStep(next)}>
              Next <ArrowRightIcon />
            </Button>
          ) : (
            <Button
              type="button"
              disabled={applying || !local.plan || (preview !== null && !preview.fits)}
              onClick={() => void apply()}
            >
              {applying ? "Setting up…" : runId ? "Try again" : `Set up ${template.name}`}
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}

function StepHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{blurb}</p>
    </>
  );
}

function OptionButtons<T extends string | boolean>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm",
            option.value === value
              ? "border-foreground bg-foreground text-background"
              : "hover:bg-muted/60",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type StepProps = {
  template: WorkspaceTemplate;
  answers: TemplateAnswersInput;
  patch: (next: Partial<TemplateAnswersInput>) => void;
};

function DecisionsStep({
  template,
  answers,
  patch,
  preview,
}: StepProps & { preview: Preview | null }) {
  const modules = new Set(answers.modules ?? []);
  return (
    <>
      <StepHeading
        title="How do you work?"
        blurb="A few questions about your business. You can change any of these later."
      />
      <div className="flex flex-col gap-6">
        {template.toggles.map((toggle) => {
          const current = answers.toggles?.[toggle.id] ?? toggle.default;
          return (
            <div key={toggle.id} className="flex flex-col gap-2">
              <p className="text-sm font-medium">{toggle.label}</p>
              {toggle.help ? (
                <p className="text-xs text-muted-foreground">{toggle.help}</p>
              ) : null}
              <OptionButtons
                label={toggle.label}
                options={
                  toggle.kind === "boolean"
                    ? [
                        { value: true, label: "Yes" },
                        { value: false, label: "No" },
                      ]
                    : toggle.options
                }
                value={current}
                onChange={(value) =>
                  patch({ toggles: { ...answers.toggles, [toggle.id]: value } })
                }
              />
            </div>
          );
        })}

        {template.modules.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Extras</p>
            <p className="text-xs text-muted-foreground">
              Optional lists to run more of the business in Graft.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {template.modules.map((module) => {
                const status = preview?.modules.find((candidate) => candidate.id === module.id);
                const locked = status !== undefined && !status.selected && !status.fits;
                const checked = modules.has(module.id);
                return (
                  <label
                    key={module.id}
                    className={cn(
                      "flex gap-3 rounded-md border p-3 text-sm",
                      locked ? "opacity-70" : "cursor-pointer hover:bg-muted/40",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={locked}
                      onCheckedChange={(value) => {
                        const nextModules = new Set(modules);
                        if (value === true) nextModules.add(module.id);
                        else nextModules.delete(module.id);
                        patch({ modules: [...nextModules] });
                      }}
                      className="mt-0.5"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{module.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {module.description}
                      </span>
                      {locked ? (
                        <span className="mt-1 flex items-center gap-1 text-xs">
                          <LockIcon className="size-3" /> More than your plan has room for.{" "}
                          <Link href="/account" className="underline underline-offset-4">
                            View plans
                          </Link>
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function NamesStep({
  template,
  answers,
  patch,
  fullPlan,
  fill,
}: StepProps & { fullPlan: WorkspacePlan | null; fill: (text: string) => string }) {
  const omitted = new Set(answers.omitFields ?? []);
  return (
    <>
      <StepHeading
        title="Names & details"
        blurb="Call things what you call them, and leave out anything you don't need."
      />
      <div className="flex flex-col gap-8">
        {template.nouns.map((noun) => {
          const current = answers.nouns?.[noun.id] ?? noun;
          const set = (next: Partial<{ singular: string; plural: string }>) =>
            patch({
              nouns: {
                ...answers.nouns,
                [noun.id]: { singular: current.singular, plural: current.plural, ...next },
              },
            });
          return (
            <div key={noun.id} className="flex flex-col gap-2">
              <p className="text-sm font-medium">{noun.question}</p>
              <div className="grid max-w-md grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${noun.id}-one`} className="text-xs">
                    One
                  </Label>
                  <Input
                    id={`${noun.id}-one`}
                    value={current.singular}
                    maxLength={40}
                    onChange={(event) => set({ singular: event.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${noun.id}-many`} className="text-xs">
                    Many
                  </Label>
                  <Input
                    id={`${noun.id}-many`}
                    value={current.plural}
                    maxLength={40}
                    onChange={(event) => set({ plural: event.target.value })}
                  />
                </div>
              </div>
            </div>
          );
        })}

        {fullPlan?.entities.map((entity) => {
          const blueprint = template.entities.find((candidate) => candidate.ref === entity.ref);
          const optional = entity.fields.filter((field) =>
            blueprint?.fields.some(
              (candidate) => candidate.key === field.key && candidate.optional,
            ),
          );
          return (
            <div key={entity.ref} className="flex flex-col gap-2">
              <p className="text-sm font-medium">{entity.name}</p>
              <ul className="flex flex-wrap gap-1.5">
                {entity.fields.map((field) => {
                  const path = `${entity.ref}.${field.key}`;
                  const isOptional = optional.includes(field);
                  const on = !omitted.has(path);
                  if (!isOptional) {
                    return (
                      <li
                        key={field.key}
                        className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs"
                        title="Needed — always included"
                      >
                        {fill(field.label)}
                      </li>
                    );
                  }
                  return (
                    <li key={field.key}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          const nextOmitted = new Set(omitted);
                          if (on) nextOmitted.add(path);
                          else nextOmitted.delete(path);
                          patch({ omitFields: [...nextOmitted] });
                        }}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-xs",
                          on
                            ? "border-foreground"
                            : "border-dashed text-muted-foreground line-through",
                        )}
                      >
                        {fill(field.label)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          Filled fields are always included. Click an outlined one to leave it out — you can add
          fields back, or new ones, from the list itself later.
        </p>
      </div>
    </>
  );
}

function MoneyStep({
  template,
  answers,
  patch,
  plan,
  fill,
}: StepProps & { plan: WorkspacePlan | null; fill: (text: string) => string }) {
  const bookingForms =
    plan?.forms.filter(
      (form) =>
        form.booking &&
        template.forms.find((candidate) => candidate.ref === form.ref)?.booking?.deposit,
    ) ?? [];
  const paymentForms =
    plan?.forms.filter(
      (form) => template.forms.find((candidate) => candidate.ref === form.ref)?.payment,
    ) ?? [];
  const termsForms =
    plan?.forms.filter(
      (form) => template.forms.find((candidate) => candidate.ref === form.ref)?.terms,
    ) ?? [];

  return (
    <>
      <StepHeading
        title="Money & terms"
        blurb="All optional. Leave anything blank and add it to the form later."
      />
      <div className="flex max-w-xl flex-col gap-8">
        {bookingForms.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Take a deposit?</p>
            <p className="text-xs text-muted-foreground">
              Recorded on every booking as a percentage of its price, so you know what&apos;s
              owed upfront.
            </p>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={1}
                max={100}
                className="w-24"
                placeholder="None"
                value={answers.depositPercent ?? ""}
                onChange={(event) =>
                  patch({
                    depositPercent:
                      event.target.value === "" ? null : Number(event.target.value),
                  })
                }
                aria-label="Deposit percentage"
              />
              <span className="text-sm text-muted-foreground">% of the booking</span>
            </div>
          </div>
        ) : null}

        {paymentForms.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="payment-link" className="text-sm font-medium">
              Stripe payment link
            </Label>
            <p className="text-xs text-muted-foreground">
              Create one in your Stripe dashboard (Payment links → New) and paste it here.
              Customers are sent to it after submitting{" "}
              {paymentForms.map((f) => `“${f.name}”`).join(" and ")}.
            </p>
            <Input
              id="payment-link"
              placeholder="https://buy.stripe.com/…"
              value={answers.paymentLink ?? ""}
              onChange={(event) => patch({ paymentLink: event.target.value || null })}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={answers.paymentRequired ?? false}
                disabled={!answers.paymentLink}
                onCheckedChange={(value) => patch({ paymentRequired: value === true })}
              />
              Send customers straight to payment (otherwise it&apos;s offered)
            </label>
          </div>
        ) : null}

        {termsForms.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{fill(template.policy.title)}</p>
            <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              {fill(template.policy.body)}
            </p>
            <p className="text-xs text-muted-foreground">
              Shown on your public form — edit the wording on the form afterwards. Add a link to
              your full terms and customers must tick to agree before they can submit.
            </p>
            <Input
              placeholder="https://your-site.com/terms (optional)"
              value={answers.termsUrl ?? ""}
              onChange={(event) => patch({ termsUrl: event.target.value || null })}
              aria-label="Link to your terms"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={answers.sampleData ?? true}
              onCheckedChange={(value) => patch({ sampleData: value === true })}
              className="mt-0.5"
            />
            <span>
              Add example entries
              <span className="block text-xs text-muted-foreground">
                A few made-up entries so your public page works straight away. Edit or delete
                them any time.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={answers.publish ?? true}
              onCheckedChange={(value) => patch({ publish: value === true })}
              className="mt-0.5"
            />
            <span>
              Publish my public page now
              <span className="block text-xs text-muted-foreground">
                Untick to check it over first — you can publish from Forms.
              </span>
            </span>
          </label>
        </div>
      </div>
    </>
  );
}

function ReviewStep({
  preview,
  error,
  localPlan,
}: {
  preview: Preview | null;
  error: string | null;
  localPlan: WorkspacePlan | null;
}) {
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!preview || !localPlan) {
    return <p className="text-sm text-muted-foreground">Working out what to create…</p>;
  }
  const { plan } = preview;
  const recordsFor = (ref: string) => plan.records.filter((record) => record.entityRef === ref);

  return (
    <>
      <StepHeading
        title="Here's what we'll set up"
        blurb="Everything below is ordinary and editable once it's created."
      />
      <div className="flex flex-col gap-4">
        {plan.entities.map((entity) => {
          const samples = recordsFor(entity.ref);
          const bookable = samples.filter((record) => record.pool).length;
          return (
            <Card key={entity.ref}>
              <CardHeader>
                <CardTitle className="text-base">{entity.name}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  A list with {entity.fields.length} fields
                  {samples.length > 0 ? `, ${samples.length} example entries` : ""}
                  {bookable > 0 ? `, ${bookable} bookable` : ""}
                </p>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-1.5">
                  {entity.fields.map((field) => (
                    <li key={field.key} className="rounded-full border px-2 py-0.5 text-xs">
                      {field.label}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}

        {plan.forms.map((form) => (
          <Card key={form.ref}>
            <CardHeader>
              <CardTitle className="text-base">{form.name}</CardTitle>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                <li>
                  {form.visibility === "public"
                    ? form.publish
                      ? "Public page, published straight away"
                      : "Public page, not published yet"
                    : "Staff form"}
                </li>
                {form.catalogue ? <li>Customers choose from your list first</li> : null}
                {form.booking ? (
                  <li>
                    Takes bookings — availability checked, priced{" "}
                    {form.booking.rateBasis === "daily"
                      ? "per day"
                      : form.booking.rateBasis === "hourly"
                        ? "per hour"
                        : "per booking"}
                    {form.booking.depositPercent
                      ? `, ${form.booking.depositPercent}% deposit`
                      : ""}
                  </li>
                ) : null}
                {form.payment ? <li>Sends customers to your Stripe payment link</li> : null}
                {form.content.some(
                  (block) => block.kind === "link" && block.requireAgreement,
                ) ? (
                  <li>Customers must agree to your terms</li>
                ) : null}
              </ul>
            </CardHeader>
          </Card>
        ))}

        {preview.renamed.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            You already have {preview.renamed.map((rename) => `“${rename.from}”`).join(", ")},
            so the new ones will be called{" "}
            {preview.renamed.map((rename) => `“${rename.to}”`).join(", ")}.
          </p>
        ) : null}

        <div className="rounded-md border p-4">
          <p className="mb-2 text-sm font-medium">Your plan</p>
          <table className="w-full text-sm">
            <tbody>
              {(Object.keys(METER_LABEL) as (keyof PlanRequirements)[])
                .filter((meter) => preview.requirements[meter] > 0)
                .map((meter) => {
                  const remaining = preview.allowance[meter];
                  const over = remaining !== null && preview.requirements[meter] > remaining;
                  return (
                    <tr key={meter} className={cn(over && "text-destructive")}>
                      <td className="py-0.5">{METER_LABEL[meter]}</td>
                      <td className="py-0.5 text-right tabular-nums">
                        uses {preview.requirements[meter]} of{" "}
                        {remaining === null ? "unlimited" : `${remaining} left`}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {!preview.fits ? (
            <p className="mt-2 text-sm text-destructive">
              This is more than your plan has left. Go back and leave out some extras, or{" "}
              <Link href="/account" className="font-medium underline underline-offset-4">
                upgrade
              </Link>
              .
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Done({ template, applied }: { template: WorkspaceTemplate; applied: Applied }) {
  const publicForms = applied.forms.filter((form) => form.visibility === "public");
  const bookingWithoutPools =
    applied.pools === 0 && applied.forms.some((form) => form.takesBookings);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <p className="text-4xl" aria-hidden="true">
          {template.icon}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">You&apos;re set up</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {template.name} created {applied.entities.length} lists and {applied.forms.length}{" "}
          {applied.forms.length === 1 ? "form" : "forms"}
          {applied.records > 0 ? `, with ${applied.records} example entries` : ""}.
        </p>
      </div>

      {publicForms.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Your public {publicForms.length === 1 ? "page" : "pages"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {publicForms.map((form) => (
              <div key={form.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{form.name}</span>
                {form.publicSlug ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={`/f/${form.publicSlug}`} target="_blank" rel="noreferrer">
                      Open <ExternalLinkIcon />
                    </a>
                  </Button>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/forms/${form.id}`}>Review and publish</Link>
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What next</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            {applied.entities[0] ? (
              <li>
                <Link
                  href={`/entities/${applied.entities[0].id}`}
                  className="underline underline-offset-4"
                >
                  Open {applied.entities[0].name}
                </Link>{" "}
                and replace the examples with your own — add photos and prices.
              </li>
            ) : null}
            {bookingWithoutPools ? (
              <li>
                Make each entry bookable from its page, so availability can be checked — without
                that, bookings can&apos;t be taken.
              </li>
            ) : (
              <li>New entries you add later need making bookable from their page too.</li>
            )}
            <li>
              Try your public page yourself, then share its link on your website and social
              pages.
            </li>
            <li>
              New requests arrive in{" "}
              {applied.entities[1] ? (
                <Link
                  href={`/entities/${applied.entities[1].id}`}
                  className="underline underline-offset-4"
                >
                  {applied.entities[1].name}
                </Link>
              ) : (
                "your lists"
              )}{" "}
              and bookings in{" "}
              <Link href="/operations" className="underline underline-offset-4">
                Operations
              </Link>
              .
            </li>
          </ol>
        </CardContent>
      </Card>

      <Button asChild className="self-start">
        <Link href="/home">Go to your overview</Link>
      </Button>
    </div>
  );
}
