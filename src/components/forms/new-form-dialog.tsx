"use client";

/**
 * "New form" (2026-08-21). Creates through `POST /api/v1/forms`, the same
 * endpoint the onboarding wizard uses — the last of the four things the
 * guide describes to get a screen of its own.
 *
 * What the server's contract forces this form to get right:
 *   - `fields` names entity field *keys*, never definitions. A form is an
 *     ordered subset of its entity's fields and cannot invent one, so this
 *     is a checkbox list over the chosen entity rather than a field editor.
 *   - `slug` and `visibility` are fixed at creation (`updateFormSchema`
 *     accepts neither), so both are decided here and the dialog says so.
 *   - A public form is a draft until published; an internal one has no
 *     publish step and charges `internal_forms` quota immediately.
 */
import { useEffect, useMemo, useState } from "react";
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
import { slugify } from "@/server/services/slugs";
import type { FieldLike } from "@/lib/entities/record-values";

export type EntityOption = { id: string; name: string; fields: FieldLike[] };
export type CreatedForm = { id: string; name: string };

export function NewFormDialog({
  open,
  onOpenChange,
  entities,
  /** Pre-selects an entity — used when arriving from that entity's page. */
  defaultEntityId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entities: EntityOption[];
  defaultEntityId?: string;
  onCreated: (form: CreatedForm) => void;
}) {
  const [entityId, setEntityId] = useState(defaultEntityId ?? "");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "internal">("public");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quota: boolean } | null>(null);

  const entity = entities.find((candidate) => candidate.id === entityId);

  useEffect(() => {
    if (!open) return;
    setEntityId(defaultEntityId ?? "");
    setName("");
    setSlug("");
    setSlugEdited(false);
    setVisibility("public");
    setError(null);
  }, [open, defaultEntityId]);

  // Every field is on the form by default — the common case is "collect all
  // of it", and unticking is easier than hunting for what you forgot.
  useEffect(() => {
    setSelectedKeys(entity ? entity.fields.map((field) => field.key) : []);
  }, [entity]);

  const effectiveSlug = slugEdited ? slug : (slugify(name) ?? "");

  const invalid = useMemo(() => {
    if (!entityId) return "Choose the entity this form writes into.";
    if (!name.trim()) return "Give this form a name.";
    if (!effectiveSlug) return "This form needs a URL slug.";
    if (selectedKeys.length === 0) return "Include at least one field.";
    // A required field the form omits can never be filled in, so the record
    // it tries to create would always be refused.
    const missing = (entity?.fields ?? []).filter(
      (field) => field.required && !selectedKeys.includes(field.key),
    );
    if (missing.length > 0) {
      return `${missing.map((field) => field.label).join(", ")} ${missing.length === 1 ? "is" : "are"} required on this entity, so the form must include ${missing.length === 1 ? "it" : "them"}.`;
    }
    return null;
  }, [entityId, name, effectiveSlug, selectedKeys, entity]);

  async function submit() {
    if (invalid || !entity) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/forms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId,
          name: name.trim(),
          slug: effectiveSlug,
          visibility,
          // Sent in the entity's own field order, which is the order the
          // public page renders them in.
          fields: entity.fields
            .filter((field) => selectedKeys.includes(field.key))
            .map((field) => ({ key: field.key })),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        { data: CreatedForm } | { error: { code: string; message: string } } | null;

      if (!response.ok || !body || "error" in body) {
        setError({
          message:
            body && "error" in body ? body.error.message : "We couldn't create this form.",
          quota: body && "error" in body ? body.error.code === "QUOTA_EXCEEDED" : false,
        });
        return;
      }

      onCreated(body.data);
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
          <DialogTitle>New form</DialogTitle>
          <DialogDescription>
            A form collects records for one entity. Its address and visibility are fixed once
            created — the name and fields can change later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-1">
          <div>
            <Label htmlFor="form-entity" className="mb-1 block text-xs">
              Collects records for
            </Label>
            <Select
              value={entityId}
              onValueChange={setEntityId}
              disabled={entities.length === 0}
            >
              <SelectTrigger id="form-entity" aria-label="Entity" className="w-full">
                <SelectValue
                  placeholder={entities.length ? "Choose an entity…" : "No entities yet"}
                />
              </SelectTrigger>
              <SelectContent>
                {entities.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="form-name" className="mb-1 block text-xs">
              Name
            </Label>
            <Input
              id="form-name"
              value={name}
              maxLength={120}
              placeholder="Book a table"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="form-slug" className="mb-1 block text-xs">
              URL slug <span className="text-muted-foreground">(permanent)</span>
            </Label>
            <Input
              id="form-slug"
              value={effectiveSlug}
              maxLength={64}
              placeholder="book-a-table"
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(slugify(event.target.value) ?? "");
              }}
            />
          </div>

          <div>
            <Label htmlFor="form-visibility" className="mb-1 block text-xs">
              Visibility <span className="text-muted-foreground">(permanent)</span>
            </Label>
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(value as "public" | "internal")}
            >
              <SelectTrigger id="form-visibility" aria-label="Visibility" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public — anyone with the link</SelectItem>
                <SelectItem value="internal">Internal — your team only</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {visibility === "public"
                ? "Created as a draft. It only goes live, and only counts against your active forms, once you publish it."
                : "No public link and no publish step. Counts against your internal forms straight away."}
            </p>
          </div>

          {entity ? (
            <div>
              <Label className="mb-2 block text-xs">Fields to collect</Label>
              <ul className="flex flex-col gap-1.5">
                {entity.fields.map((field) => (
                  <li key={field.key}>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selectedKeys.includes(field.key)}
                        aria-label={field.label}
                        onCheckedChange={(checked) =>
                          setSelectedKeys((prev) =>
                            checked === true
                              ? [...prev, field.key]
                              : prev.filter((key) => key !== field.key),
                          )
                        }
                      />
                      {field.label}
                      {field.required ? (
                        <span className="text-xs text-muted-foreground">required</span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

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
          <p className="text-xs text-muted-foreground">{invalid ?? " "}</p>
          <Button
            type="button"
            disabled={busy || invalid !== null}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create form"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
