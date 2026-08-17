"use client";

/**
 * The authenticated home — the one real screen wired to the state
 * primitives (GRAFT-11.5 AC1): fetches the tenant's entities and renders
 * `LoadingState` while in flight, `EmptyState` when there are none yet, and
 * `ErrorState` (a safe message, never the caught error) on failure.
 * `GatedControl` (AC3) demos the disabled+upgrade-prompt pattern against the
 * tier `/me` already reported — Free tenants see "Add entity" disabled with
 * an inline explanation; Premium+ tenants see it enabled. Dashboard widgets
 * belong to GRAFT-13.
 */
import { useEffect, useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedControl } from "@/components/ui/gated-control";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";

type FetchState =
  { status: "loading" } | { status: "error" } | { status: "ready"; count: number };

async function fetchEntityCount(): Promise<FetchState> {
  try {
    const response = await fetch("/api/v1/entities", { credentials: "include" });
    if (!response.ok) return { status: "error" };
    const body = (await response.json()) as { data: unknown[] };
    return { status: "ready", count: body.data.length };
  } catch {
    return { status: "error" };
  }
}

export default function AppHomePage() {
  const { me } = useMe();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchEntityCount().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const canAddEntity = me ? me.tenant.tier !== "free" : false;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <GatedControl
          allowed={canAddEntity}
          upgradeMessage="Upgrade to Premium to add more than the Free plan's entities."
        >
          <Button type="button" size="sm">
            <PlusIcon /> Add entity
          </Button>
        </GatedControl>
      </div>

      <div className="mt-6">
        {state.status === "loading" ? <LoadingState label="Loading your entities…" /> : null}
        {state.status === "error" ? (
          <ErrorState description="We couldn't load your entities. Please try again." />
        ) : null}
        {state.status === "ready" && state.count === 0 ? (
          <EmptyState
            title="No entities yet"
            description="Entities are the records your business tracks — customers, jobs, bookings. Create your first one to get started."
          />
        ) : null}
        {state.status === "ready" && state.count > 0 ? (
          <p className="text-sm text-muted-foreground">
            You have {state.count} {state.count === 1 ? "entity" : "entities"}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
