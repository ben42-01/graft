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
 */
import { useRef, useState } from "react";
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
import { contrastingTextColor } from "@/lib/contrast";
import type { FieldDef } from "@/server/services/entities";

type FormValues = Record<string, unknown>;

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; message: string };

export function PublicFormRenderer({
  tenantSlug,
  formSlug,
  fields,
  primaryColor,
}: {
  tenantSlug: string;
  formSlug: string;
  fields: FieldDef[];
  primaryColor: string | null;
}) {
  const renderedAt = useRef(Date.now());
  // A plain, uncontrolled ref — not registered on `form` — so it can never
  // leak into `values` and end up inside `data`, which the entity schema
  // validates strictly (an unknown key there is a 400, not silently dropped).
  const honeypotRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const form = useForm<FormValues>({
    defaultValues: Object.fromEntries(
      fields.map((f) => [f.key, f.type === "checkbox" ? false : ""]),
    ),
  });

  const buttonStyle = primaryColor
    ? { backgroundColor: primaryColor, color: contrastingTextColor(primaryColor) }
    : undefined;

  async function onSubmit(values: FormValues) {
    setState({ status: "submitting" });
    try {
      const response = await fetch(
        `/api/v1/public/forms/${tenantSlug}/${formSlug}/submissions`,
        {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            data: values,
            _hp: honeypotRef.current?.value || undefined,
            _t: renderedAt.current,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        const fieldErrors = body?.error?.details?.fields as Record<string, string> | undefined;
        if (fieldErrors) {
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
      setState({ status: "success" });
    } catch {
      setState({ status: "error", message: "Network error. Please try again." });
    }
  }

  if (state.status === "success") {
    return (
      <div role="status" className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-lg font-medium">Thanks — your submission was received.</p>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {/* Honeypot — invisible to a real visitor, never tabbed to. */}
        <div
          aria-hidden="true"
          className="absolute -left-[9999px] top-auto h-0 w-0 overflow-hidden"
        >
          <label htmlFor="_hp">Leave this field empty</label>
          <input id="_hp" type="text" tabIndex={-1} autoComplete="off" ref={honeypotRef} />
        </div>

        {fields.map((field) => (
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
                <FormControl>{renderInput(field, rhf)}</FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}

        {state.status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : null}

        <Button type="submit" disabled={state.status === "submitting"} style={buttonStyle}>
          {state.status === "submitting" ? "Submitting…" : "Submit"}
        </Button>
      </form>
    </Form>
  );
}

/** AC2 — every entity field type maps to a real, labelled input. File fields
 * are out of scope (Constraints — no upload path exists yet) and render a
 * plain note instead of a crash. */
function renderInput(
  field: FieldDef,
  rhf: { value: unknown; onChange: (value: unknown) => void; name: string; onBlur: () => void },
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
        <Input
          type="date"
          value={rhf.value as string}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
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
