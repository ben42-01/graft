"use client";

/**
 * "New entity" — the in-app entity builder (2026-08-21 UI refinement).
 *
 * Until now the only code path in the product that created an entity was the
 * onboarding wizard's step 4, so an established workspace had no way to add
 * its second entity — which in turn blocked the Record List and Calendar
 * widgets, both of which are bound to one. This is that missing path, and it
 * writes through `POST /api/v1/entities`, the same endpoint the wizard uses
 * (no builder-only write path, the principle GRAFT-12 AC5 established).
 *
 * The server is the authority on what is valid (`createEntitySchema`,
 * src/server/services/entities.ts). This form's job is only to keep the user
 * from submitting something it already knows will be refused, and to report
 * the server's own message when it is. The field rows themselves, and the
 * rules they enforce, are shared with the schema editor on an entity's page
 * (`FieldRowsEditor`, `@/lib/entities/draft-fields`).
 *
 * Keys are derived from labels rather than typed: they end up in a Mongo
 * path (GRAFT-07) and are immutable once created, so hand-typing them is
 * both a footgun and a detail most users shouldn't have to think about.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
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
import { FieldRowsEditor } from "@/components/entities/field-rows-editor";
import {
  draftFieldsFrom,
  initialDraftFields,
  toFieldPayload,
  validateFields,
  type DraftField,
} from "@/lib/entities/draft-fields";
import type { EntityTemplate } from "@/lib/entity-templates";
import { toIdentifier } from "@/lib/entities/field-types";

export type CreatedEntity = { id: string; key: string; name: string };

type SubmitError = { message: string; quota: boolean };

/** The first reason this draft would be refused, or `null` when it is ready. */
function validationError(name: string, key: string, fields: DraftField[]): string | null {
  if (!name.trim()) return "Give this entity a name.";
  if (!key) return "This entity needs a key — letters, digits and underscores.";
  return validateFields(fields);
}

export function NewEntityDialog({
  open,
  onOpenChange,
  onCreated,
  template = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (entity: CreatedEntity) => void;
  /** Seeds the form from an entity template (@/lib/entity-templates). It is
   * a starting point, not a commitment — every field stays editable, which
   * is why templates are copied in rather than referenced. */
  template?: EntityTemplate | null;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [fields, setFields] = useState<DraftField[]>(initialDraftFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SubmitError | null>(null);

  const effectiveKey = keyEdited ? key : toIdentifier(name);
  const invalid = validationError(name, effectiveKey, fields);

  function reset() {
    setName("");
    setKey("");
    setKeyEdited(false);
    setFields(initialDraftFields());
    setError(null);
  }

  // Seed on open, so picking a different template re-seeds rather than
  // leaving the previous one's fields behind.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!template) return;
    setName(template.entity.name);
    setKey(template.entity.key);
    setKeyEdited(true);
    setFields(draftFieldsFrom(template.entity.fields, false));
  }, [open, template]);

  async function submit() {
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/entities", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: effectiveKey,
          name: name.trim(),
          fields: toFieldPayload(fields),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        { data: CreatedEntity } | { error: { code: string; message: string } } | null;

      if (!response.ok || !body || "error" in body) {
        const code = body && "error" in body ? body.error.code : "";
        setError({
          message:
            body && "error" in body ? body.error.message : "We couldn't create this entity.",
          quota: code === "QUOTA_EXCEEDED",
        });
        return;
      }

      onCreated(body.data);
      reset();
      onOpenChange(false);
    } catch {
      setError({ message: "Network error. Try again.", quota: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New entity</DialogTitle>
          <DialogDescription>
            An entity is a kind of record your business tracks — customers, jobs, bookings. Its
            fields become the columns your records, forms and dashboards use.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-1">
          <div className="flex flex-wrap gap-3">
            <div className="min-w-48 flex-1">
              <Label htmlFor="entity-name" className="mb-1 block text-xs">
                Name
              </Label>
              <Input
                id="entity-name"
                value={name}
                maxLength={120}
                placeholder="Customers"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="min-w-40 flex-1">
              <Label htmlFor="entity-key" className="mb-1 block text-xs">
                Key <span className="text-muted-foreground">(permanent)</span>
              </Label>
              <Input
                id="entity-key"
                value={effectiveKey}
                maxLength={64}
                placeholder="customers"
                onChange={(event) => {
                  setKeyEdited(true);
                  setKey(toIdentifier(event.target.value));
                }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs">Fields</Label>
            <FieldRowsEditor fields={fields} onChange={setFields} />
          </div>

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

        <DialogFooter className="sm:justify-between">
          {/* The blocking reason, rather than a disabled button with no
           * explanation — the form has enough inputs to make "why can't I
           * submit?" a real question. */}
          <p className="text-xs text-muted-foreground">{invalid ?? " "}</p>
          <Button
            type="button"
            disabled={busy || invalid !== null}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create entity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
