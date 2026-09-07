"use client";

/**
 * One form: which fields it collects, whether it is live, and its public
 * link (2026-08-21).
 *
 * The server's model has two independent switches, and this page keeps them
 * visibly separate rather than collapsing them into one "on" toggle:
 *   - `published` — has a public URL been assigned. Publishing reserves
 *     `active_forms` quota; unpublishing does not give it back (the same
 *     lifetime-counter convention entities and records use).
 *   - `enabled` — the kill switch, which outranks `published`. A killed form
 *     stays dark even while still marked published (`isFormServable`).
 * Only `name`, `fields` and `enabled` are patchable; slug and visibility are
 * fixed at creation, so they render as facts, not inputs.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import type { FieldLike } from "@/lib/entities/record-values";

type FormView = {
  id: string;
  entityId: string;
  name: string;
  slug: string;
  publicSlug: string | null;
  visibility: "public" | "internal";
  published: boolean;
  enabled: boolean;
  fields: FieldLike[];
};

type EntityView = { id: string; name: string; fields: FieldLike[] };

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; form: FormView; entity: EntityView | null };

export default function FormPage() {
  const params = useParams<{ formId: string }>();
  const router = useRouter();
  const formId = params.formId;

  const [state, setState] = useState<State>({ status: "loading" });
  const [name, setName] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/forms/${formId}`, { credentials: "include" });
      if (!response.ok) {
        setState({ status: "error" });
        return;
      }
      const { data: form } = (await response.json()) as { data: FormView };
      setName(form.name);
      setSelectedKeys(form.fields.map((field) => field.key));

      // The entity is what says which fields *could* be on this form; the
      // form itself only carries the ones already chosen.
      const entityResponse = await fetch(`/api/v1/entities/${form.entityId}`, {
        credentials: "include",
      });
      const entity = entityResponse.ok
        ? ((await entityResponse.json()) as { data: EntityView }).data
        : null;

      setState({ status: "ready", form, entity });
    } catch {
      setState({ status: "error" });
    }
  }, [formId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, onDone?: () => void) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/api/v1/forms/${formId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          error: { message: string };
        } | null;
        setError(errorBody?.error.message ?? "We couldn't save this form.");
        return;
      }
      setSaved(true);
      await load();
      onDone?.();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function setPublished(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/forms/${formId}/${next ? "publish" : "unpublish"}`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error: { code: string; message: string };
        } | null;
        setError(body?.error.message ?? "We couldn't change this form's state.");
        return;
      }
      await load();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteForm() {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/forms/${formId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (response.ok) {
        router.push("/forms");
        return;
      }
      setError("We couldn't delete this form.");
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") return <LoadingState label="Loading form…" />;
  if (state.status === "error") return <ErrorState description="We couldn't load this form." />;

  const { form, entity } = state;
  const publicUrl =
    form.publicSlug && typeof window !== "undefined"
      ? `${window.location.origin}/f/${form.publicSlug}`
      : null;
  const missingRequired = (entity?.fields ?? []).filter(
    (field) => field.required && !selectedKeys.includes(field.key),
  );
  const live = form.visibility === "public" && form.published && form.enabled;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/forms"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; Forms
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{form.name}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {form.visibility === "public" ? "Public" : "Internal"} · /{form.slug} · collects for{" "}
          {entity ? (
            <Link href={`/entities/${form.entityId}`} className="underline underline-offset-4">
              {entity.name}
            </Link>
          ) : (
            "an entity that no longer exists"
          )}
        </p>
      </div>

      {form.visibility === "public" ? (
        <Card className={live ? "border-graft-green/40 ring-1 ring-graft-green/10" : undefined}>
          <CardHeader>
            <CardTitle className="text-base">{live ? "Live" : "Not live"}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {live
                ? "Anyone with this link can submit. Each submission arrives as a record."
                : form.published
                  ? "Published, but switched off — nobody can reach it until you switch it back on."
                  : "A draft. Publishing gives it a public address and counts it against your active forms."}
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {publicUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-xs">
                  {publicUrl}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(publicUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href={`/f/${form.publicSlug}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon /> Open
                  </a>
                </Button>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {form.published ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void setPublished(false)}
                >
                  Unpublish
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void setPublished(true)}
                >
                  Publish
                </Button>
              )}

              {/* The kill switch is deliberately its own control: it stops a
               * live form instantly without giving up its public address. */}
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={form.enabled}
                  aria-label="Accepting submissions"
                  disabled={busy}
                  onCheckedChange={(checked) => void patch({ enabled: checked === true })}
                />
                Accepting submissions
              </label>
            </div>

            {!form.published ? (
              <p className="text-xs text-muted-foreground">
                Unpublishing later keeps the address reserved, but does not return the
                active-form allowance it used.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Name &amp; fields</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="max-w-sm">
            <Label htmlFor="form-rename" className="mb-1 block text-xs">
              Name
            </Label>
            <Input
              id="form-rename"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div>
            <Label className="mb-2 block text-xs">Fields collected</Label>
            {entity ? (
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
            ) : (
              <p className="text-sm text-muted-foreground">
                This form&apos;s entity is gone, so its fields can no longer be edited.
              </p>
            )}
          </div>

          {missingRequired.length > 0 ? (
            <p className="text-xs text-graft-warn">
              {missingRequired.map((field) => field.label).join(", ")}{" "}
              {missingRequired.length === 1 ? "is" : "are"} required on the entity. A submission
              without {missingRequired.length === 1 ? "it" : "them"} is refused, so the form
              must collect {missingRequired.length === 1 ? "it" : "them"}.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {saved ? <p className="text-xs text-muted-foreground">Saved.</p> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button
              type="button"
              disabled={
                busy || !name.trim() || selectedKeys.length === 0 || missingRequired.length > 0
              }
              onClick={() =>
                void patch({
                  name: name.trim(),
                  fields: (entity?.fields ?? [])
                    .filter((field) => selectedKeys.includes(field.key))
                    .map((field) => ({ key: field.key })),
                })
              }
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>

            {confirmingDelete ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  Delete {form.name}? Its link stops working.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => void deleteForm()}
                >
                  Delete form
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2Icon /> Delete form
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
