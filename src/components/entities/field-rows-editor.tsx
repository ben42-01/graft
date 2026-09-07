"use client";

/**
 * The rows of an entity's field editor, shared by "New entity" and the
 * schema editor on an entity's page — one place where a field's label, key,
 * type, options and required flag are edited, so the two can't diverge.
 *
 * State lives with the caller (it is what gets POSTed or PATCHed); this
 * renders it and reports edits back.
 */
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  FIELD_TYPE_OPTIONS,
  toIdentifier,
  type OfferedFieldType,
} from "@/lib/entities/field-types";
import { newDraftField, patchDraftField, type DraftField } from "@/lib/entities/draft-fields";

export function FieldRowsEditor({
  fields,
  onChange,
  /** Shown under a row whose key already exists on the saved entity — its
   * key is what records are stored under and cannot be renamed in place. */
  lockPersistedKeys = false,
}: {
  fields: DraftField[];
  onChange: (fields: DraftField[]) => void;
  lockPersistedKeys?: boolean;
}) {
  const update = (rowId: string, patch: Partial<DraftField>) =>
    onChange(
      fields.map((field) => (field.rowId === rowId ? patchDraftField(field, patch) : field)),
    );

  return (
    <div className="flex flex-col gap-2">
      {fields.map((field) => {
        const keyLocked = lockPersistedKeys && field.persisted;
        return (
          <div
            key={field.rowId}
            data-testid="field-row"
            className="flex flex-wrap items-end gap-2 rounded-md border p-2"
          >
            <div className="min-w-40 flex-1">
              <Label htmlFor={`${field.rowId}-label`} className="mb-1 block text-xs">
                Label
              </Label>
              <Input
                id={`${field.rowId}-label`}
                value={field.label}
                maxLength={120}
                onChange={(event) => update(field.rowId, { label: event.target.value })}
                className="h-8"
              />
            </div>

            <div className="w-32">
              <Label htmlFor={`${field.rowId}-key`} className="mb-1 block text-xs">
                Key
              </Label>
              <Input
                id={`${field.rowId}-key`}
                value={field.key}
                maxLength={64}
                disabled={keyLocked}
                title={keyLocked ? "A saved field's key can't be renamed" : undefined}
                onChange={(event) =>
                  update(field.rowId, {
                    key: toIdentifier(event.target.value),
                    keyEdited: true,
                  })
                }
                className="h-8"
              />
            </div>

            <div className="w-36">
              <Label htmlFor={`${field.rowId}-type`} className="mb-1 block text-xs">
                Type
              </Label>
              <Select
                value={field.type}
                onValueChange={(value) =>
                  update(field.rowId, { type: value as OfferedFieldType })
                }
              >
                <SelectTrigger
                  id={`${field.rowId}-type`}
                  aria-label={`${field.label || "Field"} type`}
                  size="sm"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.type} value={option.type}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {field.type === "select" ? (
              <div className="min-w-44 flex-1">
                <Label htmlFor={`${field.rowId}-options`} className="mb-1 block text-xs">
                  Options <span className="text-muted-foreground">(comma separated)</span>
                </Label>
                <Input
                  id={`${field.rowId}-options`}
                  value={field.options}
                  placeholder="New, In progress, Done"
                  onChange={(event) => update(field.rowId, { options: event.target.value })}
                  className="h-8"
                />
              </div>
            ) : null}

            <label className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={field.required}
                aria-label={`${field.label || "Field"} required`}
                onCheckedChange={(checked) =>
                  update(field.rowId, { required: checked === true })
                }
              />
              Required
            </label>

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${field.label || "field"}`}
              disabled={fields.length === 1}
              onClick={() => onChange(fields.filter((row) => row.rowId !== field.rowId))}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...fields, newDraftField()])}
      >
        <PlusIcon /> Add field
      </Button>
    </div>
  );
}
