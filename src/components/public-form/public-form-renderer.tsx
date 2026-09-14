"use client";

/**
 * The interactive half of the public form page (GRAFT-10) — everything the
 * server component can't do: capture input, submit, show inline errors and a
 * no-reload success state (AC3). Field rendering is driven entirely by the
 * form's own `FieldDef[]` (AC2) — nothing here hardcodes a field name.
 *
 * Anti-abuse fields ride along invisibly (AC3/AC4 of GRAFT-09, this is just
 * the client half): `_hp` is a honeypot no real visitor sees or tabs to, `_t`
 * is the timestamp `isSpamSubmission` compares against, captured once at
 * mount so it reflects render time, not submit time.
 *
 * What is sent is built by `toRecordPayload`, the same function the in-app
 * record dialog uses, rather than by posting the form's raw values. An
 * untouched optional input holds `""`, and `""` is not an absent value to the
 * compiled entity schema — it is an invalid date, an invalid phone number and
 * a NaN. Posting raw values 400s a form whose visitor simply left the
 * optional field alone, which is exactly what they are for.
 *
 * Catalogue mode lives here rather than one level up because the chosen item
 * is part of the submission: it travels as `_selection`, beside `_hp` and
 * `_t`, never inside `data`. The server treats the selection key as its own
 * field and overwrites whatever `data` says about it — so the input for that
 * key is not rendered at all, since asking a visitor to type a record id
 * would be offering them a control whose value is discarded.
 */
import { useRef, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateField } from "@/components/ui/date-field";
import { CatalogueBrowser } from "@/components/public-form/catalogue-browser";
import { placeContent, type ContentBlock, type LinkBlock } from "@/lib/content-blocks";
import { contrastingTextColor } from "@/lib/contrast";
import {
  toRecordPayload,
  type FormValues as RecordFormValues,
} from "@/lib/entities/record-values";
import type { FieldDef } from "@/server/services/entities";

export type CatalogueShape = { selectionKey: string | null } | null;

type FormValues = Record<string, unknown>;

/** The payment handoff a 201 may carry (GRAFT-24 AC4, AC9). */
export type PaymentHandoff = { url: string; required: boolean };

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; payment: PaymentHandoff | null }
  | { status: "error"; message: string };

export function PublicFormRenderer({
  tenantSlug,
  formSlug,
  fields,
  primaryColor,
  catalogue = null,
  timeFields = [],
  content = [],
  navigate = (url: string) => window.location.assign(url),
}: {
  tenantSlug: string;
  formSlug: string;
  fields: FieldDef[];
  primaryColor: string | null;
  catalogue?: CatalogueShape;
  /**
   * Keys that carry a booking's start or end (`bookingTimeFields`). A `date`
   * input yields a whole day at midnight, which cannot describe a four-hour
   * hire, so these ask for a time as well.
   */
  timeFields?: string[];
  /** Notes and links the business placed between the fields. */
  content?: ContentBlock[];
  /**
   * How the browser leaves for payment (AC9). A seam, not a feature: jsdom
   * has no navigation, so a component test needs somewhere to observe that
   * the redirect happened — and it happens only *after* the 201, never
   * before.
   */
  navigate?: (url: string) => void;
}) {
  const renderedAt = useRef(Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The server owns this key's value, so there is nothing to type into it.
  const visibleFields = catalogue?.selectionKey
    ? fields.filter((field) => field.key !== catalogue.selectionKey)
    : fields;
  // A plain, uncontrolled ref — not registered on `form` — so it can never
  // leak into `values` and end up inside `data`, which the entity schema
  // validates strictly (an unknown key there is a 400, not silently dropped).
  const honeypotRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const [agreed, setAgreed] = useState<Set<string>>(new Set());
  const [agreementErrors, setAgreementErrors] = useState<Record<string, string>>({});
  const mustAgree = content.filter(
    (block): block is LinkBlock => block.kind === "link" && block.requireAgreement,
  );
  const form = useForm<FormValues>({
    defaultValues: Object.fromEntries(
      fields.map((f) => [f.key, f.type === "checkbox" ? false : ""]),
    ),
  });

  const buttonStyle = primaryColor
    ? { backgroundColor: primaryColor, color: contrastingTextColor(primaryColor) }
    : undefined;

  async function onSubmit(values: FormValues) {
    // Checked here so the visitor is told at once; the server checks again.
    // First, because an unticked agreement is a fix the visitor can make
    // without ever seeing a payload error underneath it.
    const unticked = mustAgree.filter((block) => !agreed.has(block.id));
    setAgreementErrors(
      Object.fromEntries(
        unticked.map((block) => [block.id, `Please agree to ${block.label} before sending.`]),
      ),
    );
    if (unticked.length > 0) return;

    // The selection key is never rendered and never sent inside `data` — the
    // server writes it from `_selection` — so it is dropped before the
    // payload is built rather than being offered as an empty string.
    const answerable = visibleFields.filter((field) => field.type !== "file");
    const payload = toRecordPayload(values as RecordFormValues, answerable);
    if (!payload.ok) {
      setState({ status: "error", message: payload.message });
      return;
    }

    setState({ status: "submitting" });
    try {
      const response = await fetch(
        `/api/v1/public/forms/${tenantSlug}/${formSlug}/submissions`,
        {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            data: payload.data,
            _hp: honeypotRef.current?.value || undefined,
            _t: renderedAt.current,
            _selection: selectedId ?? undefined,
            _agreed: agreed.size > 0 ? [...agreed] : undefined,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        const fieldErrors = body?.error?.details?.fields as Record<string, string> | undefined;
        if (fieldErrors) {
          const serverAgreements: Record<string, string> = {};
          for (const [key, message] of Object.entries(fieldErrors)) {
            if (key.startsWith("_agreed."))
              serverAgreements[key.slice("_agreed.".length)] = message;
          }
          if (Object.keys(serverAgreements).length > 0) setAgreementErrors(serverAgreements);
          for (const [key, message] of Object.entries(fieldErrors)) {
            const fieldKey = key.split(".")[0];
            if (fields.some((f) => f.key === fieldKey)) {
              form.setError(fieldKey, { message });
            }
          }
        }
        setState({
          status: "error",
          message: body?.error?.message ?? "Something went wrong. Please try again.",
        });
        return;
      }
      // AC9, AC10 — the submission is already accepted and written by the
      // time any of this runs: the record, the submission row and the meter
      // increment do not depend on the visitor ever paying. `required` only
      // decides whether they are sent to Stripe or offered the link.
      const payment = (body?.data?.payment as PaymentHandoff | undefined) ?? null;
      setState({ status: "success", payment });
      if (payment?.required) navigate(payment.url);
    } catch {
      setState({ status: "error", message: "Network error. Please try again." });
    }
  }

  if (state.status === "success") {
    return (
      <div role="status" className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-lg font-medium">Thanks — your submission was received.</p>
        {state.payment ? (
          <p className="mt-3 text-sm">
            {state.payment.required ? (
              <>Taking you to payment…</>
            ) : (
              <a
                className="underline underline-offset-4"
                href={state.payment.url}
                rel="noopener noreferrer"
              >
                Pay now
              </a>
            )}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6" noValidate>
        {/* Above the fields: a visitor who has to scroll past a form to see
         * what is on offer has already been asked for their details. */}
        {catalogue ? (
          <CatalogueBrowser
            tenantSlug={tenantSlug}
            formSlug={formSlug}
            selectedId={selectedId}
            onSelect={setSelectedId}
            primaryColor={primaryColor}
          />
        ) : null}

        <div className="flex flex-col gap-4">
          {/* Honeypot — invisible to a real visitor, never tabbed to. */}
          <div
            aria-hidden="true"
            className="absolute -left-[9999px] top-auto h-0 w-0 overflow-hidden"
          >
            <label htmlFor="_hp">Leave this field empty</label>
            <input id="_hp" type="text" tabIndex={-1} autoComplete="off" ref={honeypotRef} />
          </div>

          {/* Placed over *all* fields, so a note after the hidden selection
           * field still lands where the business put it. */}
          {placeContent(fields, content).map((item) => {
            if (item.kind === "block") {
              const { block } = item;
              return (
                <ContentBlockView
                  key={`block-${block.id}`}
                  block={block}
                  agreed={agreed.has(block.id)}
                  error={agreementErrors[block.id] ?? null}
                  onAgreeChange={(on) =>
                    setAgreed((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(block.id);
                      else next.delete(block.id);
                      return next;
                    })
                  }
                />
              );
            }
            const field = item.field;
            if (!visibleFields.includes(field)) return null;
            return (
              <FormField
                key={field.key}
                control={form.control}
                name={field.key}
                rules={{ required: field.required ? "This field is required" : false }}
                render={({ field: rhf }) => (
                  <FormItem>
                    <FormLabel>
                      {field.label}
                      {field.required ? <span aria-hidden="true"> *</span> : null}
                    </FormLabel>
                    <FormControl>
                      {renderInput(field, rhf, timeFields.includes(field.key))}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            );
          })}

          {state.status === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          ) : null}

          <Button type="submit" disabled={state.status === "submitting"} style={buttonStyle}>
            {state.status === "submitting" ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/**
 * A note or a link the business left. A note is plain text — never HTML — and
 * a link always opens in a new tab without handing this page to it.
 */
function ContentBlockView({
  block,
  agreed,
  error,
  onAgreeChange,
}: {
  block: ContentBlock;
  agreed: boolean;
  error: string | null;
  onAgreeChange: (agreed: boolean) => void;
}) {
  if (block.kind === "notice") {
    return (
      <div role="note" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
        {block.title ? <p className="font-medium">{block.title}</p> : null}
        <p className="whitespace-pre-line text-muted-foreground">{block.body}</p>
      </div>
    );
  }

  const link = (
    <a
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline underline-offset-4"
    >
      {block.label}
      <ExternalLinkIcon className="ml-1 inline size-3" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
  if (!block.requireAgreement) return <p className="text-sm">{link}</p>;

  const id = `agree-${block.id}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2 text-sm">
        <Checkbox
          id={id}
          checked={agreed}
          onCheckedChange={(checked) => onAgreeChange(checked === true)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <label htmlFor={id}>
          I agree to {link}
          <span aria-hidden="true"> *</span>
        </label>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** AC2 — every entity field type maps to a real, labelled input. File fields
 * are out of scope (Constraints — no upload path exists yet) and render a
 * plain note instead of a crash. */
function renderInput(
  field: FieldDef,
  rhf: { value: unknown; onChange: (value: unknown) => void; name: string; onBlur: () => void },
  withTime = false,
) {
  switch (field.type) {
    case "checkbox":
      return (
        <Checkbox
          checked={Boolean(rhf.value)}
          onCheckedChange={(checked) => rhf.onChange(checked === true)}
          aria-label={field.label}
        />
      );
    case "select":
      return (
        <Select value={String(rhf.value ?? "")} onValueChange={rhf.onChange}>
          <SelectTrigger aria-label={field.label} className="w-full">
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "number":
      return (
        <Input
          type="number"
          value={rhf.value as string | number}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
    case "date":
      return (
        <DateField
          value={(rhf.value as string) ?? ""}
          onChange={rhf.onChange}
          withTime={withTime}
          name={rhf.name}
          aria-label={field.label}
        />
      );
    case "email":
      return (
        <Input
          type="email"
          value={rhf.value as string}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
    case "phone":
      return (
        <Input
          type="tel"
          value={rhf.value as string}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
    case "file":
      return (
        <p className="text-sm text-muted-foreground">
          File uploads aren&apos;t supported on this form yet.
        </p>
      );
    default:
      return (
        <Input
          type="text"
          value={rhf.value as string}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
  }
}
