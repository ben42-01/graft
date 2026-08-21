"use client";

/**
 * Add or edit one record — the form that finally makes an entity useful
 * (2026-08-21 UI refinement). Before it, entities could be created and then
 * only looked at: nothing in the product wrote a row.
 *
 * The form is generated from the entity's own field definitions, so it is
 * always in step with the schema, and the values are converted by
 * `@/lib/entities/record-values` into exactly what the per-entity compiled
 * schema accepts. Writes go to `POST /api/v1/entities/:id/records` and
 * `PATCH .../records/:recordId`.
 *
 * One API-level limitation worth knowing: a PATCH merges into the stored
 * record, so clearing an already-set optional field is not expressible —
 * blanking it leaves the previous value. Nothing in the UI pretends
 * otherwise; it says so where the form can't do it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  emptyFormValues,
  formValuesFrom,
  toRecordPayload,
  type FieldLike,
  type FormValues,
} from "@/lib/entities/record-values";

export type RecordRow = { id: string; data: Record<string, unknown> };

const INPUT_TYPE: Record<string, string> = {
  text: "text",
  number: "number",
  date: "date",
  email: "email",
  phone: "tel",
};

export function RecordDialog({
  open,
  onOpenChange,
  entityId,
  entityName,
  fields,
  /** Editing an existing row, or `null` to add a new one. */
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityName: string;
  fields: FieldLike[];
  editing: RecordRow | null;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => emptyFormValues(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quota: boolean } | null>(null);

  // Re-seed whenever the dialog opens, so "edit" shows that row's values and
  // "add" never inherits the last edit's.
  useEffect(() => {
    if (!open) return;
    setValues(editing ? formValuesFrom(editing.data, fields) : emptyFormValues(fields));
    setError(null);
  }, [open, editing, fields]);

  const setValue = (key: string, value: string | boolean) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  async function submit() {
    const payload = toRecordPayload(values, fields);
    if (!payload.ok) {
      setError({ message: payload.message, quota: false });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const url = editing
        ? `/api/v1/entities/${entityId}/records/${editing.id}`
        : `/api/v1/entities/${entityId}/records`;
      const response = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.data),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error: { code: string; message: string };
        } | null;
        setError({
          message: body?.error.message ?? "We couldn't save this record.",
          quota: body?.error.code === "QUOTA_EXCEEDED",
        });
        return;
      }

      onSaved();
      onOpenChange(false);
    } catch {
      setError({ message: "Network error. Try again.", quota: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit" : "New"} {entityName.toLowerCase()} record
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Change any value and save. Clearing an optional field keeps its previous value."
              : `Fill in the fields you defined on ${entityName}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-1">
          {fields.map((field) => {
            const inputId = `record-${field.key}`;
            const value = values[field.key];

            if (field.type === "checkbox") {
              return (
                <label key={field.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={inputId}
                    checked={value === true}
                    onCheckedChange={(checked) => setValue(field.key, checked === true)}
                  />
                  {field.label}
                  {field.required ? <span aria-hidden>*</span> : null}
                </label>
              );
            }

            return (
              <div key={field.key}>
                <Label htmlFor={inputId} className="mb-1 block text-xs">
                  {field.label}
                  {field.required ? <span aria-hidden>*</span> : null}
                </Label>

                {field.type === "select" ? (
                  <Select
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(next) => setValue(field.key, next)}
                  >
                    <SelectTrigger id={inputId} aria-label={field.label} className="w-full">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={inputId}
                    type={INPUT_TYPE[field.type] ?? "text"}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                )}
              </div>
            );
          })}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error.message}{" "}
              {error.quota ? (
                <Link
                  href="/account"
                  className="font-medium underline underline-offset-4"
                  onClick={() => onOpenChange(false)}
                >
                  View plans
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
