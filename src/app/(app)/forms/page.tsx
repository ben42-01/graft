"use client";

/**
 * Forms — the list (2026-08-21). Closes the last gap in the loop the guide
 * describes: a form writes records into an entity, and until now nothing in
 * the app could create one outside the first-run wizard.
 *
 * `?entity=<id>` pre-selects an entity in the create dialog, which is how
 * an entity's own page links here.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLinkIcon, FileTextIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { NewFormDialog, type EntityOption } from "@/components/forms/new-form-dialog";
import { cn } from "@/lib/utils";

type FormSummary = {
  id: string;
  entityId: string;
  name: string;
  slug: string;
  publicSlug: string | null;
  visibility: "public" | "internal";
  published: boolean;
  enabled: boolean;
};

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; items: FormSummary[] };

/** One badge summarising a form's real state — published, drafted, killed. */
function formState(form: FormSummary): {
  label: string;
  tone: "live" | "draft" | "off";
} {
  if (form.visibility === "internal") return { label: "Internal", tone: "draft" };
  if (!form.enabled) return { label: "Disabled", tone: "off" };
  if (!form.published) return { label: "Draft", tone: "draft" };
  return { label: "Live", tone: "live" };
}

const TONE_CLASS: Record<"live" | "draft" | "off", string> = {
  live: "border-graft-green/40 bg-graft-green/10 text-graft-green dark:text-graft-green-light",
  draft: "text-muted-foreground",
  off: "border-destructive/40 text-destructive",
};

export default function FormsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const entityParam = searchParams.get("entity") ?? undefined;

  const [state, setState] = useState<State>({ status: "loading" });
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [creating, setCreating] = useState(Boolean(entityParam));

  const load = useCallback(async () => {
    try {
      const [formsRes, entitiesRes] = await Promise.all([
        fetch("/api/v1/forms?limit=100", { credentials: "include" }),
        fetch("/api/v1/entities?limit=100", { credentials: "include" }),
      ]);
      if (!formsRes.ok) {
        setState({ status: "error" });
        return;
      }
      const forms = (await formsRes.json()) as { data: FormSummary[] };
      setState({ status: "ready", items: forms.data });
      if (entitiesRes.ok) {
        const body = (await entitiesRes.json()) as { data: EntityOption[] };
        setEntities(body.data);
      }
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const entityName = (id: string) => entities.find((entity) => entity.id === id)?.name;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forms</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pages that collect records for one of your entities.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={entities.length === 0}
          onClick={() => setCreating(true)}
        >
          <PlusIcon /> New form
        </Button>
      </div>

      <div className="mt-6">
        {state.status === "loading" ? <LoadingState label="Loading your forms…" /> : null}
        {state.status === "error" ? (
          <ErrorState description="We couldn't load your forms." />
        ) : null}

        {state.status === "ready" && state.items.length === 0 ? (
          <>
            <EmptyState
              title="No forms yet"
              description="A form is a page other people fill in — its answers arrive as records on the entity you point it at."
            />
            {entities.length === 0 ? (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                You need an entity first —{" "}
                <Link href="/entities" className="underline underline-offset-4">
                  create one
                </Link>{" "}
                and a form can collect for it.
              </p>
            ) : null}
          </>
        ) : null}

        {state.status === "ready" && state.items.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {state.items.map((form) => {
              const badge = formState(form);
              return (
                <li key={form.id}>
                  <div className="flex items-center gap-3 rounded-md border px-4 py-3">
                    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    <Link href={`/forms/${form.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{form.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {entityName(form.entityId) ?? "Unknown entity"} · /{form.slug}
                      </span>
                    </Link>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                        TONE_CLASS[badge.tone],
                      )}
                    >
                      {badge.label}
                    </span>
                    {form.publicSlug && form.published && form.enabled ? (
                      <a
                        href={`/f/${form.publicSlug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${form.name}`}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLinkIcon className="size-4" />
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <NewFormDialog
        open={creating}
        onOpenChange={setCreating}
        entities={entities}
        defaultEntityId={entityParam}
        onCreated={(form) => router.push(`/forms/${form.id}`)}
      />
    </div>
  );
}
