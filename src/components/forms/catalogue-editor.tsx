"use client";

/**
 * Catalogue mode — turning a form from a blank page into a front for the
 * business's own records.
 *
 * The shape of this control follows the shape of the risk. Publishing a
 * catalogue makes tenant data readable by anonymous visitors, so the two
 * decisions that matter are made explicitly and visibly here:
 *
 *   - **Which entity is browsed.** Deliberately a separate choice from the
 *     entity the form writes to. A form collects bookings and browses rental
 *     items; collapsing the two would show every visitor the submissions of
 *     everyone before them, which is why the server keeps them as different
 *     fields and this asks for them as different questions.
 *   - **Which fields are public.** An allowlist, presented as one checkbox per
 *     field with nothing ticked by default, so a field is private until
 *     somebody chooses otherwise. The copy says "anyone with the link can see
 *     these" rather than "shown on the card", because that is the actual
 *     consequence and the builder is the only person who can weigh it.
 *
 * Everything is saved with an explicit button. An autosaving control that
 * publishes data to the internet as you tick boxes is not a forgiving shape.
 */
import { useEffect, useState } from "react";
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FieldLike } from "@/lib/entities/record-values";
import { isImageField } from "@/lib/entities/record-values";

/** Mirrors `MAX_CATALOGUE_FIELDS` in src/server/services/forms.ts. */
export const MAX_CATALOGUE_FIELDS = 6;

export type CatalogueView = {
  entityId: string;
  fields: string[];
  imageField: string | null;
  pageSize: number;
  selectionKey: string | null;
};

export type EntityOption = { id: string; name: string; fields: FieldLike[] };

export function CatalogueEditor({
  catalogue,
  entities,
  /** The entity this form writes submissions to — where a selection lands. */
  submissionFields,
  busy,
  onSave,
}: {
  catalogue: CatalogueView | null;
  entities: EntityOption[];
  submissionFields: FieldLike[];
  busy: boolean;
  onSave: (next: CatalogueView | null) => void;
}) {
  const [enabled, setEnabled] = useState(catalogue !== null);
  const [draft, setDraft] = useState<CatalogueView>(
    catalogue ?? {
      entityId: "",
      fields: [],
      imageField: null,
      pageSize: 12,
      selectionKey: null,
    },
  );

  // Re-seed when the server's answer arrives or changes under us.
  useEffect(() => {
    setEnabled(catalogue !== null);
    if (catalogue) setDraft(catalogue);
  }, [catalogue]);

  const browsed = entities.find((entity) => entity.id === draft.entityId);
  const imageFields = (browsed?.fields ?? []).filter(isImageField);
  // A record id is a string, so only a text field can hold one — the same
  // rule `resolveCatalogue` enforces server-side.
  const selectionTargets = submissionFields.filter((field) => field.type === "text");

  const toggleField = (key: string) =>
    setDraft((prev) => ({
      ...prev,
      fields: prev.fields.includes(key)
        ? prev.fields.filter((existing) => existing !== key)
        : prev.fields.length >= MAX_CATALOGUE_FIELDS
          ? prev.fields
          : [...prev.fields, key],
    }));

  const ready = draft.entityId !== "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GlobeIcon className="size-4" aria-hidden="true" /> Catalogue
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Let visitors browse what you sell and pick one, instead of filling in a blank form.
          The pictures come from the records themselves, so the catalogue is whatever is
          actually in your data.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          Show a catalogue on this form
        </label>

        {enabled ? (
          <>
            <div>
              <Label htmlFor="catalogue-entity" className="mb-1 block text-xs">
                Records to show
              </Label>
              <Select
                value={draft.entityId}
                onValueChange={(value) =>
                  // Field keys belong to the old entity; keeping them would
                  // publish whatever happens to share a name.
                  setDraft((prev) => ({
                    ...prev,
                    entityId: value,
                    fields: [],
                    imageField: null,
                  }))
                }
              >
                <SelectTrigger
                  id="catalogue-entity"
                  aria-label="Records to show"
                  className="w-full"
                >
                  <SelectValue placeholder="Choose an entity…" />
                </SelectTrigger>
                <SelectContent>
                  {entities.map((entity) => (
                    <SelectItem key={entity.id} value={entity.id}>
                      {entity.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {browsed ? (
              <>
                <fieldset>
                  <legend className="mb-1 text-xs font-medium">
                    Details to show ({draft.fields.length}/{MAX_CATALOGUE_FIELDS})
                  </legend>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Anyone with the link can see these. Everything you leave unticked stays
                    private, including anything you add to {browsed.name} later.
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {browsed.fields.map((field) => {
                      const checked = draft.fields.includes(field.key);
                      return (
                        <label key={field.key} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={checked}
                            disabled={!checked && draft.fields.length >= MAX_CATALOGUE_FIELDS}
                            onCheckedChange={() => toggleField(field.key)}
                          />
                          {field.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <div>
                  <Label htmlFor="catalogue-image" className="mb-1 block text-xs">
                    Picture
                  </Label>
                  <Select
                    value={draft.imageField ?? "none"}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        imageField: value === "none" ? null : value,
                      }))
                    }
                  >
                    <SelectTrigger id="catalogue-image" aria-label="Picture" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No picture</SelectItem>
                      {imageFields.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {imageFields.length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {browsed.name} has no image field yet — add one to its fields, then upload
                      a photo on each record.
                    </p>
                  ) : null}
                </div>

                <div>
                  <Label htmlFor="catalogue-selection" className="mb-1 block text-xs">
                    Record the choice in
                  </Label>
                  <Select
                    value={draft.selectionKey ?? "none"}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        selectionKey: value === "none" ? null : value,
                      }))
                    }
                  >
                    <SelectTrigger
                      id="catalogue-selection"
                      aria-label="Record the choice in"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Don&apos;t record it</SelectItem>
                      {selectionTargets.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    A text field on this form&apos;s own entity. Without one, you get the
                    enquiry but not which item it was about.
                  </p>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        <div>
          <Button
            type="button"
            size="sm"
            disabled={busy || (enabled && !ready)}
            onClick={() => onSave(enabled ? draft : null)}
          >
            {busy ? "Saving…" : "Save catalogue"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
