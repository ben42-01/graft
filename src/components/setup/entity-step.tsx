"use client";

/**
 * The step that creates one entity — used twice in a run, for the thing
 * itself and for the requests about it.
 *
 * It writes through `POST /api/v1/entities`, the same endpoint the builder
 * and the onboarding wizard use: the guided flow has no private write path,
 * so an entity it creates is indistinguishable afterwards from one made by
 * hand. That is the point. A wizard that produces special objects leaves you
 * stranded the moment you step outside it.
 *
 * Once created, the step stays on screen showing what it made rather than
 * vanishing — going back to a finished step and seeing an empty form is how
 * people end up creating the same entity twice.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldRowsEditor } from "@/components/entities/field-rows-editor";
import {
  draftFieldsFrom,
  toFieldPayload,
  validateFields,
  type DraftField,
} from "@/lib/entities/draft-fields";
import { toIdentifier } from "@/lib/entities/field-types";
import type { SuggestedField } from "@/lib/setup/suggested-fields";

export type CreatedEntity = { id: string; key: string; name: string };

export function EntityStep({
  /** Pre-filled name — the user's own noun, or "<noun> requests". */
  defaultName,
  suggested,
  /** The entity this step already created, if it is being revisited. */
  created,
  onCreated,
}: {
  defaultName: string;
  suggested: SuggestedField[];
  created: { id: string; name: string } | null;
  onCreated: (entity: CreatedEntity) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [fields, setFields] = useState<DraftField[]>(() => draftFieldsFrom(suggested, false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The name follows the noun until this entity exists; after that it is a
  // fact, and renaming happens on the entity's own page.
  useEffect(() => {
    if (!created) setName(defaultName);
  }, [defaultName, created]);

  const key = toIdentifier(name);
  const invalid = !name.trim()
    ? "Give this list a name."
    : !key
      ? "The name needs at least one letter."
      : validateFields(fields);

  async function create() {
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/entities", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, name: name.trim(), fields: toFieldPayload(fields) }),
      });
      const body = (await response.json().catch(() => null)) as
        { data: CreatedEntity } | { error: { code: string; message: string } } | null;

      if (!response.ok || !body || "error" in body) {
        setError(
          body && "error" in body ? body.error.message : "We couldn't create this list.",
        );
        return;
      }
      onCreated(body.data);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="rounded-lg border border-graft-green/40 bg-graft-green/5 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <CheckIcon className="size-4 text-graft-green" aria-hidden="true" />
          {created.name} is ready
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          It is an ordinary list — change its fields, add records or delete it any time from{" "}
          <Link
            href={`/entities/${created.id}`}
            className="font-medium underline underline-offset-4"
          >
            its own page
          </Link>
          .
        </p>
      </div>
    );
  }

  const notes = suggested.filter((field) => field.note);

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-sm">
        <Label htmlFor="setup-entity-name" className="mb-1 block text-xs">
          Name of the list
        </Label>
        <Input
          id="setup-entity-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs">Fields</Label>
        <FieldRowsEditor fields={fields} onChange={setFields} />
      </div>

      {notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {notes.map((field) => (
            <li key={field.key}>
              <span className="font-medium text-foreground">{field.label}</span> — {field.note}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="button" disabled={busy || invalid !== null} onClick={() => void create()}>
          {busy ? "Creating…" : "Create it"}
          <ArrowRightIcon className="size-4" aria-hidden="true" />
        </Button>
        <p className="text-xs text-muted-foreground">
          {invalid ?? "Nothing here is locked in."}
        </p>
      </div>
    </div>
  );
}
