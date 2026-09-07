"use client";

/**
 * The authenticated home — the one real screen wired to the state
 * primitives (GRAFT-11.5 AC1): fetches the tenant's entities and renders
 * `LoadingState` while in flight, `EmptyState` when there are none yet, and
 * `ErrorState` (a safe message, never the caught error) on failure.
 * `GatedControl` (AC3) renders the disabled+upgrade-prompt pattern against
 * the entitlement `/me` already reported. Dashboard widgets belong to
 * GRAFT-13.
 *
 * 2026-08-21 UI refinement — that gate used to read `tier !== "free"`, which
 * is not what the product sells: `TIER_LIMITS.free.entities` is 3, and
 * `createEntity` (src/server/services/entities.ts) has no tier check at all,
 * only `consumeQuota(ctx, "entities")`. So a Free tenant entitled to three
 * entities was told to upgrade to create their first — and, because Record
 * List and Calendar widgets are bound to an entity, that false gate read as
 * "dashboards need Premium" too. The gate now tracks the actual quota:
 * entities used against the tenant's own limit (`/me` reports it, so an
 * Enterprise override is honoured), and it only prompts to upgrade when the
 * tenant has genuinely run out.
 *
 * Lives at `/home`, not `/` (GRAFT-19 AC8): the public marketing/pricing
 * page now owns the root route (`src/app/(public)/page.tsx`), and Next.js
 * route groups can't both resolve to `/` — this is the authenticated side
 * of that split. Every former reference to "/" as the post-login landing
 * (nav, the app shell logo, login/signup's already-authenticated bounce,
 * `sanitizeRedirectTarget`'s default) now points at `/home`.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NewEntityDialog } from "@/components/entities/new-entity-dialog";
import { GatedControl } from "@/components/ui/gated-control";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { useMe } from "@/lib/session";

type FetchState =
  { status: "loading" } | { status: "error" } | { status: "ready"; count: number };

/** `/me` reports the tenant's materialised limits as loose JSON; anything
 * that isn't a number or an explicit `null` (unlimited) tells us nothing, so
 * it is treated as unlimited rather than as a gate. */
function readLimit(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

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
  const router = useRouter();
  const { me } = useMe();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [newEntityOpen, setNewEntityOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchEntityCount().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // `null` is unlimited and is branched on, never compared (docs/TIERS.md).
  const entityLimit = readLimit(me?.tenant.limits.entities);
  const atEntityLimit =
    state.status === "ready" && entityLimit !== null && state.count >= entityLimit;
  const canAddEntity = state.status === "ready" && !atEntityLimit;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <GatedControl
          allowed={canAddEntity}
          upgradeMessage={
            atEntityLimit ? `You've used all ${entityLimit} entities on your plan.` : ""
          }
          upgradeHref={atEntityLimit ? "/account" : null}
        >
          <Button type="button" size="sm" onClick={() => setNewEntityOpen(true)}>
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
          <>
            <EmptyState
              title="No entities yet"
              description="Entities are the records your business tracks — customers, jobs, bookings. Create your first one to get started."
            />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button asChild>
                <Link href="/entities/templates">Start from a template</Link>
              </Button>
              <Button type="button" variant="outline" onClick={() => setNewEntityOpen(true)}>
                <PlusIcon /> Build from scratch
              </Button>
              <Button asChild variant="ghost">
                <Link href="/guide">Read the guide</Link>
              </Button>
            </div>
          </>
        ) : null}
        {state.status === "ready" && state.count > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              You have {state.count} {state.count === 1 ? "entity" : "entities"}.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/entities">Open entities</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/guide">Guide</Link>
            </Button>
          </div>
        ) : null}
      </div>

      <NewEntityDialog
        open={newEntityOpen}
        onOpenChange={setNewEntityOpen}
        onCreated={(entity) => {
          setState((prev) =>
            prev.status === "ready" ? { status: "ready", count: prev.count + 1 } : prev,
          );
          // Straight into the entity — creating one and being returned to a
          // counter is exactly the dead end this refinement is fixing.
          router.push(`/entities/${entity.id}`);
        }}
      />
    </div>
  );
}
