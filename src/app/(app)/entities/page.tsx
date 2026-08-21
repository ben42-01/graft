"use client";

/**
 * Entities — the list, and the way into one (2026-08-21 UI refinement).
 *
 * The gap this closes: entities could be created (`NewEntityDialog`) and
 * then never seen again. `/home` showed a count, the dashboard composer
 * showed them in a picker, and nothing in the product listed them or opened
 * one. Every screen below `/entities` reads through the same tenant-scoped
 * endpoints the rest of the app uses.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DatabaseIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { NewEntityDialog } from "@/components/entities/new-entity-dialog";
import type { FieldLike } from "@/lib/entities/record-values";

type EntitySummary = {
  id: string;
  key: string;
  name: string;
  fields: FieldLike[];
  updatedAt: string;
};

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; items: EntitySummary[] };

export default function EntitiesPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/entities?limit=100", { credentials: "include" });
      if (!response.ok) {
        setState({ status: "error" });
        return;
      }
      const body = (await response.json()) as { data: EntitySummary[] };
      setState({ status: "ready", items: body.data });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Entities</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The kinds of record your business tracks.{" "}
            <Link href="/guide" className="underline underline-offset-4 hover:text-foreground">
              New here?
            </Link>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/entities/templates">
              <SparklesIcon /> Templates
            </Link>
          </Button>
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            <PlusIcon /> New entity
          </Button>
        </div>
      </div>

      <div className="mt-6">
        {state.status === "loading" ? <LoadingState label="Loading your entities…" /> : null}
        {state.status === "error" ? (
          <ErrorState description="We couldn't load your entities." />
        ) : null}

        {state.status === "ready" && state.items.length === 0 ? (
          <>
            <EmptyState
              title="No entities yet"
              description="An entity is a kind of record — customers, jobs, bookings. Create one and you can start adding records to it."
            />
            {/* The template gallery leads here, because "which fields does a
             * customer need?" is a worse first question than "which of
             * these fifteen is closest?". */}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button asChild>
                <Link href="/entities/templates">
                  <SparklesIcon /> Start from a template
                </Link>
              </Button>
              <Button type="button" variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon /> Build from scratch
              </Button>
            </div>
          </>
        ) : null}

        {state.status === "ready" && state.items.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {state.items.map((entity) => (
              <li key={entity.id}>
                <Link
                  href={`/entities/${entity.id}`}
                  className="flex items-center gap-3 rounded-md border px-4 py-3 transition-colors hover:bg-accent"
                >
                  <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{entity.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entity.key} · {entity.fields.length}{" "}
                      {entity.fields.length === 1 ? "field" : "fields"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <NewEntityDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => void load()}
      />
    </div>
  );
}
