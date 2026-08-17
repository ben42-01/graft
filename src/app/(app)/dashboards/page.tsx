"use client";

/**
 * Dashboard list (GRAFT-13) — create a dashboard (server enforces the
 * per-tier `dashboards` quota, AC6) and jump into its composer.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import type { DashboardView } from "@/lib/widgets/types";

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; items: DashboardView[] };

async function fetchDashboards(): Promise<State> {
  try {
    const res = await fetch("/api/v1/dashboards", { credentials: "include" });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { data: DashboardView[] };
    return { status: "ready", items: body.data };
  } catch {
    return { status: "error" };
  }
}

export default function DashboardsPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [quotaMessage, setQuotaMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetchDashboards().then(setState);
  }, []);

  async function createDashboard() {
    setCreating(true);
    setQuotaMessage(null);
    try {
      const res = await fetch("/api/v1/dashboards", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Dashboard ${new Date().toLocaleDateString()}` }),
      });
      const body = (await res.json()) as
        { data: DashboardView } | { error: { code: string; message: string } };
      if (!res.ok || !("data" in body)) {
        setQuotaMessage(
          "error" in body && body.error.code === "QUOTA_EXCEEDED"
            ? "You've reached your plan's dashboard limit. Upgrade to add another."
            : "Could not create the dashboard.",
        );
        return;
      }
      setState((prev) => ({
        status: "ready",
        items: [body.data, ...(prev.status === "ready" ? prev.items : [])],
      }));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1>
        <Button
          type="button"
          size="sm"
          onClick={() => void createDashboard()}
          disabled={creating}
        >
          <PlusIcon /> New dashboard
        </Button>
      </div>
      {quotaMessage ? <p className="mt-2 text-sm text-destructive">{quotaMessage}</p> : null}

      <div className="mt-6">
        {state.status === "loading" ? <LoadingState label="Loading dashboards…" /> : null}
        {state.status === "error" ? (
          <ErrorState description="We couldn't load your dashboards." />
        ) : null}
        {state.status === "ready" && state.items.length === 0 ? (
          <EmptyState
            title="No dashboards yet"
            description="Create a dashboard and add widgets to build your own management view."
          />
        ) : null}
        {state.status === "ready" && state.items.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {state.items.map((dashboard) => (
              <li key={dashboard.id}>
                <Link
                  href={`/dashboards/${dashboard.id}`}
                  className="block rounded-md border px-4 py-3 text-sm font-medium hover:bg-accent"
                >
                  {dashboard.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
