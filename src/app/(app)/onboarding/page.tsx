"use client";

/**
 * The first-run wizard (GRAFT-12, docs/Graft.md §3): business profile ->
 * template -> plugins -> guided entity -> guided form -> dashboard hand-off
 * -> done. `GET/PATCH /api/v1/onboarding` (src/server/services/onboarding.ts)
 * only remembers the step and the answers (AC2) — every entity, form,
 * plugin and dashboard this page creates goes through the exact same
 * `/api/v1/entities`, `/api/v1/forms`, `/api/v1/plugins/*` and
 * `/api/v1/dashboards` endpoints the normal builders use (AC5), so there is
 * no wizard-only write path and nothing this page does can leave a
 * half-created record: every create call below is the same all-or-nothing
 * one a hand-built form or entity would make (AC7).
 *
 * Logo upload is out of scope here — docs/BACKEND.md §4 requires uploads go
 * through a signed URL, and no signed-URL upload mechanism exists anywhere
 * in this codebase yet (see the `@needs-clarification` comment on GRAFT-12).
 * The profile step collects everything else and says so.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { GatedControl } from "@/components/ui/gated-control";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";
import {
  BLANK_TEMPLATE,
  findTemplate,
  INDUSTRY_OPTIONS,
  ONBOARDING_STEPS,
  STEP_LABELS,
  suggestTemplate,
  type OnboardingStep,
  type StarterTemplate,
  type TemplateField,
} from "@/lib/onboarding-templates";

type ProfileAnswers = {
  name: string;
  industry: string;
  size: string;
  region: string;
  currency: string;
  timezone: string;
};
type TemplateAnswers = { templateId: string };
type PluginsAnswers = { pluginIds: string[] };
type EntityAnswers = { entityId: string; key: string; name: string; fieldKeys: string[] };
type FormAnswers = { formId: string; name: string; slug: string; publicSlug: string | null };
type DashboardAnswers = { dashboardId: string };

type WizardData = {
  profile?: ProfileAnswers;
  template?: TemplateAnswers;
  plugins?: PluginsAnswers;
  entity?: EntityAnswers;
  form?: FormAnswers;
  dashboard?: DashboardAnswers;
};

type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const body = (await response.json().catch(() => null)) as
      { data: T } | { error: { code: string; message: string } } | null;
    if (!response.ok || !body || "error" in body) {
      const error =
        body && "error" in body ? body.error : { code: "INTERNAL", message: "Request failed" };
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, code: "INTERNAL", message: "Network error" };
  }
}

function StepIndicator({ step }: { step: OnboardingStep }) {
  const index = ONBOARDING_STEPS.indexOf(step);
  return (
    <ol
      className="mb-6 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground"
      aria-label="Onboarding progress"
    >
      {ONBOARDING_STEPS.map((s, i) => (
        <li
          key={s}
          data-testid={`onboarding-step-${s}`}
          aria-current={i === index ? "step" : undefined}
          className={
            i === index
              ? "font-semibold text-foreground"
              : i < index
                ? "text-foreground"
                : undefined
          }
        >
          {STEP_LABELS[s]}
          {i < ONBOARDING_STEPS.length - 1 ? " ›" : ""}
        </li>
      ))}
    </ol>
  );
}

function ProfileStep({
  initial,
  onNext,
}: {
  initial?: ProfileAnswers;
  onNext: (answers: ProfileAnswers) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [industry, setIndustry] = useState(initial?.industry ?? "");
  const [size, setSize] = useState(initial?.size ?? "1-5");
  const [region, setRegion] = useState(initial?.region ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tell us about your business</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="onboarding-name">Business name</Label>
          <Input id="onboarding-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="onboarding-industry">Industry</Label>
          <Select value={industry} onValueChange={setIndustry}>
            <SelectTrigger id="onboarding-industry" aria-label="Industry">
              <SelectValue placeholder="Select an industry" />
            </SelectTrigger>
            <SelectContent>
              {INDUSTRY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="onboarding-size">Team size</Label>
          <Select value={size} onValueChange={setSize}>
            <SelectTrigger id="onboarding-size" aria-label="Team size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["1-5", "6-20", "21-50", "50+"].map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onboarding-region">Region</Label>
            <Input
              id="onboarding-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="e.g. Ireland"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onboarding-currency">Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="onboarding-currency" aria-label="Currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["USD", "EUR", "GBP"].map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Logo upload is coming soon — add one later from your business settings.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          type="button"
          onClick={() => {
            if (!name.trim() || !industry) {
              setError("Business name and industry are required.");
              return;
            }
            const timezone =
              initial?.timezone ??
              (typeof Intl !== "undefined"
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : "UTC");
            onNext({
              name: name.trim(),
              industry,
              size,
              region: region.trim(),
              currency,
              timezone,
            });
          }}
        >
          Continue
        </Button>
      </CardFooter>
    </Card>
  );
}

function TemplateStep({
  industry,
  initial,
  onNext,
  onBack,
}: {
  industry: string;
  initial?: TemplateAnswers;
  onNext: (answers: TemplateAnswers) => void;
  onBack: () => void;
}) {
  const suggestion = suggestTemplate(industry);
  const [choice, setChoice] = useState<string | null>(initial?.templateId ?? null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pick a starting point</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {suggestion ? (
          <div className="rounded-lg border p-4">
            <p className="font-medium">{suggestion.label}</p>
            <p className="text-sm text-muted-foreground">
              Suggested for you — includes the {suggestion.pluginIds.join(" + ")} plugin
              {suggestion.pluginIds.length === 1 ? "" : "s"}, a &ldquo;{suggestion.entity.name}
              &rdquo; entity and a &ldquo;{suggestion.form.name}&rdquo; form. Everything is
              editable after you accept it.
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-3"
              variant={choice === suggestion.id ? "default" : "outline"}
              onClick={() => setChoice(suggestion.id)}
            >
              Use this template
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No suggestion for &ldquo;Other&rdquo; — start from a blank canvas and customize
            everything yourself.
          </p>
        )}
        <Button
          type="button"
          variant={choice === BLANK_TEMPLATE.id ? "default" : "outline"}
          onClick={() => setChoice(BLANK_TEMPLATE.id)}
        >
          Start blank
        </Button>
      </CardContent>
      <CardFooter className="justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          disabled={!choice}
          onClick={() => onNext({ templateId: choice ?? BLANK_TEMPLATE.id })}
        >
          Continue
        </Button>
      </CardFooter>
    </Card>
  );
}

type PluginView = { id: string; name: string; tier: string; eligible: boolean };

function PluginsStep({
  template,
  initial,
  onNext,
  onBack,
}: {
  template: StarterTemplate;
  initial?: PluginsAnswers;
  onNext: (answers: PluginsAnswers) => void;
  onBack: () => void;
}) {
  const [catalogue, setCatalogue] = useState<PluginView[] | null>(null);
  const [selected, setSelected] = useState<string[]>(
    initial?.pluginIds ?? [...template.pluginIds],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<PluginView[]>("/api/v1/plugins").then((result) => {
      if (!cancelled && result.ok) setCatalogue(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  // AC4 — the Free limit of 3 is enforced by the same enablePlugin() call the
  // normal plugin catalogue uses (src/server/services/plugins.ts); this never
  // pre-caps the selection client-side, it surfaces the real QUOTA_EXCEEDED.
  const handleContinue = async () => {
    setBusy(true);
    setError(null);
    const enabled: string[] = [];
    for (const pluginId of selected) {
      const result = await api(`/api/v1/plugins/${pluginId}/enable`, { method: "POST" });
      if (!result.ok) {
        setBusy(false);
        if (result.code === "QUOTA_EXCEEDED") {
          setError(
            "You've reached the Free plan's limit of 3 plugins. Upgrade to Premium to enable more.",
          );
        } else if (result.code === "FORBIDDEN") {
          setError(
            `${pluginId} needs a higher plan — deselect it to continue on your current plan.`,
          );
        } else {
          setError("Couldn't enable that plugin. Please try again.");
        }
        return;
      }
      enabled.push(pluginId);
    }
    setBusy(false);
    onNext({ pluginIds: enabled });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose your plugins</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">The Free plan includes up to 3 plugins.</p>
        {catalogue === null ? (
          <LoadingState label="Loading plugins…" />
        ) : (
          catalogue.map((plugin) => (
            <div key={plugin.id} className="flex items-center gap-2">
              <GatedControl
                allowed={plugin.eligible}
                upgradeMessage={`Requires the ${plugin.tier} plan.`}
              >
                <Checkbox
                  id={`plugin-${plugin.id}`}
                  checked={selected.includes(plugin.id)}
                  onCheckedChange={() => toggle(plugin.id)}
                />
              </GatedControl>
              <Label htmlFor={`plugin-${plugin.id}`}>{plugin.name}</Label>
            </div>
          ))
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button type="button" onClick={() => void handleContinue()} disabled={busy}>
          {busy ? "Enabling…" : "Continue"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function EntityStep({
  template,
  initial,
  onNext,
  onBack,
}: {
  template: StarterTemplate;
  initial?: EntityAnswers;
  onNext: (answers: EntityAnswers) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? template.entity.name);
  const [fields, setFields] = useState<TemplateField[]>(
    template.entity.fields.map((field) => ({ ...field })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateLabel = (index: number, label: string) =>
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, label } : f)));
  const toggleRequired = (index: number) =>
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, required: !f.required } : f)),
    );

  // AC5 — creates through POST /api/v1/entities, the same endpoint the
  // normal entity builder (GRAFT-06) uses. AC2/AC7 — resuming after this
  // entity already exists (CONFLICT, or the wizard state already recorded
  // it) reuses it rather than creating a duplicate or erroring.
  const handleContinue = async () => {
    if (initial?.entityId) {
      onNext(initial);
      return;
    }
    setBusy(true);
    setError(null);
    const created = await api<{ id: string; key: string; name: string }>("/api/v1/entities", {
      method: "POST",
      body: JSON.stringify({ key: template.entity.key, name: name.trim(), fields }),
    });
    if (created.ok) {
      setBusy(false);
      onNext({
        entityId: created.data.id,
        key: created.data.key,
        name: created.data.name,
        fieldKeys: fields.map((f) => f.key),
      });
      return;
    }
    if (created.code === "CONFLICT") {
      const existing =
        await api<{ id: string; key: string; name: string }[]>("/api/v1/entities");
      const match = existing.ok
        ? existing.data.find((e) => e.key === template.entity.key)
        : undefined;
      setBusy(false);
      if (match) {
        onNext({
          entityId: match.id,
          key: match.key,
          name: match.name,
          fieldKeys: fields.map((f) => f.key),
        });
        return;
      }
    }
    setBusy(false);
    setError("Couldn't create your entity. Please try again.");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your first entity</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entity-name">Entity name</Label>
          <Input id="entity-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Fields</Label>
          {fields.map((field, index) => (
            <div key={field.key} className="flex items-center gap-2">
              <Input
                aria-label={`Field ${field.key} label`}
                value={field.label}
                onChange={(e) => updateLabel(index, e.target.value)}
                className="max-w-48"
              />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <Checkbox
                  checked={field.required}
                  onCheckedChange={() => toggleRequired(index)}
                />
                Required
              </label>
            </div>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={busy || !name.trim()}
        >
          {busy ? "Creating…" : "Continue"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function FormStep({
  template,
  entity,
  initial,
  onNext,
  onBack,
}: {
  template: StarterTemplate;
  entity: EntityAnswers;
  initial?: FormAnswers;
  onNext: (answers: FormAnswers) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? template.form.name);
  const [slug] = useState(initial?.slug ?? template.form.slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AC5, AC6 — creates through POST /api/v1/forms and publishes through
  // POST /api/v1/forms/:id/publish, the same normal-builder endpoints
  // (GRAFT-08), so the public link the done screen shows is a real published
  // form, not a wizard-only shortcut.
  const handleContinue = async () => {
    if (initial?.publicSlug) {
      onNext(initial);
      return;
    }
    setBusy(true);
    setError(null);
    let formId = initial?.formId ?? null;
    if (!formId) {
      const created = await api<{ id: string }>("/api/v1/forms", {
        method: "POST",
        body: JSON.stringify({
          entityId: entity.entityId,
          name: name.trim(),
          slug,
          visibility: "public",
          fields: template.form.fields
            .filter((key) => entity.fieldKeys.includes(key))
            .map((key) => ({ key })),
        }),
      });
      if (created.ok) {
        formId = created.data.id;
      } else if (created.code === "CONFLICT") {
        const existing = await api<{ id: string; slug: string }[]>("/api/v1/forms");
        const match = existing.ok ? existing.data.find((f) => f.slug === slug) : undefined;
        formId = match?.id ?? null;
      }
    }
    if (!formId) {
      setBusy(false);
      setError("Couldn't create your form. Please try again.");
      return;
    }
    const published = await api<{ publicSlug: string | null }>(
      `/api/v1/forms/${formId}/publish`,
      {
        method: "POST",
      },
    );
    setBusy(false);
    if (!published.ok) {
      setError("Couldn't publish your form. Please try again.");
      return;
    }
    onNext({ formId, name: name.trim(), slug, publicSlug: published.data.publicSlug });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a form your customers can fill in</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="form-name">Form name</Label>
          <Input id="form-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="text-sm text-muted-foreground">
          This form will be published at a public link you can share as soon as you continue.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={busy || !name.trim()}
        >
          {busy ? "Publishing…" : "Continue"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function DashboardStep({
  initial,
  onNext,
  onBack,
}: {
  initial?: DashboardAnswers;
  onNext: (answers: DashboardAnswers) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AC5 — creates through POST /api/v1/dashboards (GRAFT-13); composing
  // widgets onto it is that page's own job, not reimplemented here — this
  // step is the hand-off the Scope describes. A tenant already at its
  // dashboard limit (Free: 1, docs/TIERS.md §2.1) reuses its existing
  // dashboard instead of hitting QUOTA_EXCEEDED — the hand-off is "land on a
  // dashboard", not "always mint a new one".
  const handleContinue = async () => {
    if (initial?.dashboardId) {
      onNext(initial);
      return;
    }
    setBusy(true);
    setError(null);
    const existing = await api<{ id: string }[]>("/api/v1/dashboards");
    if (existing.ok && existing.data.length > 0) {
      setBusy(false);
      onNext({ dashboardId: existing.data[0]!.id });
      return;
    }
    const result = await api<{ id: string }>("/api/v1/dashboards", {
      method: "POST",
      body: JSON.stringify({ name: "My Dashboard", widgets: [] }),
    });
    setBusy(false);
    if (!result.ok) {
      setError("Couldn't create your dashboard. Please try again.");
      return;
    }
    onNext({ dashboardId: result.data.id });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your dashboard</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          We&rsquo;ll create a home dashboard for you now. Drag on tables, KPI cards, calendars
          and charts any time from the dashboard composer.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button type="button" onClick={() => void handleContinue()} disabled={busy}>
          {busy ? "Creating…" : "Continue"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function DoneStep({ data }: { data: WizardData }) {
  const [copied, setCopied] = useState(false);
  const publicSlug = data.form?.publicSlug;
  const publicUrl =
    publicSlug && typeof window !== "undefined"
      ? `${window.location.origin}/f/${publicSlug}`
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>You&rsquo;re all set</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1 text-sm">
          <li>✓ Business profile — {data.profile?.name}</li>
          <li>✓ {data.plugins?.pluginIds.length ?? 0} plugin(s) enabled</li>
          <li>✓ Entity created — {data.entity?.name}</li>
          <li>✓ Form published — {data.form?.name}</li>
          <li>✓ Dashboard ready</li>
        </ul>
        {publicUrl ? (
          <div className="flex flex-col gap-2 rounded-lg border p-4">
            <p className="text-sm font-medium">Share your form</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={publicUrl} aria-label="Public form link" />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
            <a
              className="text-sm text-primary underline"
              href={`mailto:?subject=${encodeURIComponent("Check out our new form")}&body=${encodeURIComponent(publicUrl)}`}
            >
              Share by email
            </a>
          </div>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button asChild>
          <a
            href={
              data.dashboard?.dashboardId ? `/dashboards/${data.dashboard.dashboardId}` : "/"
            }
          >
            Go to your dashboard
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}

export default function OnboardingPage() {
  const { me } = useMe();
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [step, setStep] = useState<OnboardingStep>("profile");
  const [data, setData] = useState<WizardData>({});

  useEffect(() => {
    let cancelled = false;
    void api<{ step: OnboardingStep; data: WizardData }>("/api/v1/onboarding").then(
      (result) => {
        if (cancelled) return;
        if (!result.ok) {
          setLoadStatus("error");
          return;
        }
        setStep(result.data.step);
        setData(result.data.data ?? {});
        setLoadStatus("ready");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // AC2 — every transition is persisted immediately, so closing the browser
  // mid-wizard resumes at exactly this step with this data on the next GET.
  const advance = <K extends keyof WizardData>(
    nextStep: OnboardingStep,
    key: K,
    value: WizardData[K],
  ) => {
    const patch = { [key]: value } as Partial<WizardData>;
    setData((prev) => ({ ...prev, ...patch }));
    setStep(nextStep);
    void api("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ step: nextStep, data: patch }),
    });
  };

  if (loadStatus === "loading") return <LoadingState label="Loading your onboarding…" />;
  if (loadStatus === "error") {
    return (
      <ErrorState description="We couldn't load your onboarding progress. Please try again." />
    );
  }

  const template = findTemplate(data.template?.templateId ?? BLANK_TEMPLATE.id);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        Welcome{me ? `, ${me.user.name ?? ""}` : ""}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Let&rsquo;s get your workspace ready in a few minutes.
      </p>
      <StepIndicator step={step} />
      {step === "profile" ? (
        <ProfileStep
          initial={data.profile}
          onNext={(answers) => advance("template", "profile", answers)}
        />
      ) : null}
      {step === "template" ? (
        <TemplateStep
          industry={data.profile?.industry ?? "other"}
          initial={data.template}
          onNext={(answers) => advance("plugins", "template", answers)}
          onBack={() => setStep("profile")}
        />
      ) : null}
      {step === "plugins" ? (
        <PluginsStep
          template={template}
          initial={data.plugins}
          onNext={(answers) => advance("entity", "plugins", answers)}
          onBack={() => setStep("template")}
        />
      ) : null}
      {step === "entity" ? (
        <EntityStep
          template={template}
          initial={data.entity}
          onNext={(answers) => advance("form", "entity", answers)}
          onBack={() => setStep("plugins")}
        />
      ) : null}
      {step === "form" && data.entity ? (
        <FormStep
          template={template}
          entity={data.entity}
          initial={data.form}
          onNext={(answers) => advance("dashboard", "form", answers)}
          onBack={() => setStep("entity")}
        />
      ) : null}
      {step === "dashboard" ? (
        <DashboardStep
          initial={data.dashboard}
          onNext={(answers) => advance("done", "dashboard", answers)}
          onBack={() => setStep("form")}
        />
      ) : null}
      {step === "done" ? <DoneStep data={data} /> : null}
    </div>
  );
}
