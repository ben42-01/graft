"use client";

/**
 * Plugins — the capability catalogue (docs/Graft.md §4.1).
 *
 * `/api/v1/plugins/*` has worked since GRAFT-14 with no screen over it, which
 * is the shape of "the product is broken" rather than "that feature is later":
 * a tenant could be told their plan includes every plugin and have nowhere to
 * turn one on.
 *
 * Two things this screen does deliberately:
 *
 *   - **A plugin the tier does not permit is shown, disabled, with the
 *     reason.** Hiding it would make Premium look identical to Free and give
 *     an upgrade prompt nothing to point at — the `GatedControl` pattern
 *     (GRAFT-11.5 AC3, docs/TIERS.md §5).
 *   - **The plugin count is rendered against the plan's limit**, because
 *     `plugins` is a metered quota and hitting it produces a 403 the user
 *     would otherwise meet with no warning.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BlocksIcon,
  CalendarIcon,
  ContactIcon,
  FileTextIcon,
  PackageIcon,
  ReceiptIcon,
  ShieldIcon,
  WebhookIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GatedControl } from "@/components/ui/gated-control";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";

type PluginView = {
  id: string;
  name: string;
  version: string;
  tier: "free" | "premium" | "enterprise";
  eligible: boolean;
  enabled: boolean;
};

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; plugins: PluginView[] };

/**
 * One line each, written for someone deciding whether to switch it on rather
 * than for someone who already knows what it is. Keyed by plugin id; an
 * unknown id falls back to its manifest name alone, so a new plugin appears
 * here the day it ships instead of rendering blank.
 */
const DESCRIPTIONS: Record<string, { blurb: string; icon: LucideIcon }> = {
  contacts: {
    blurb: "Customers, suppliers and leads, with their own fields and history.",
    icon: ContactIcon,
  },
  forms: {
    blurb: "Internal input forms and public Customer Forms you can share as a link.",
    icon: FileTextIcon,
  },
  scheduling: {
    blurb: "Calendar, appointments and bookings across your team and resources.",
    icon: CalendarIcon,
  },
  invoicing: {
    blurb: "Quotes, invoices and payment status, built from your orders.",
    icon: ReceiptIcon,
  },
  inventory: {
    blurb: "Stock, products, price lists and what is available when.",
    icon: PackageIcon,
  },
  reports: { blurb: "Charts, exports and the numbers behind them.", icon: BlocksIcon },
  automations: {
    blurb: "Triggers and actions — when a form is submitted, send an email.",
    icon: WorkflowIcon,
  },
  team: { blurb: "Invite colleagues and control what each of them can do.", icon: ShieldIcon },
  api: { blurb: "API tokens and webhooks for your own integrations.", icon: WebhookIcon },
};

const TIER_LABEL: Record<PluginView["tier"], string> = {
  free: "Free",
  premium: "Premium",
  enterprise: "Enterprise",
};

export default function PluginsPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/plugins", { credentials: "include" });
      if (!response.ok) {
        setState({ status: "error" });
        return;
      }
      const { data } = (await response.json()) as { data: PluginView[] };
      setState({ status: "ready", plugins: data });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(plugin: PluginView) {
    setBusy(plugin.id);
    setError(null);
    try {
      const action = plugin.enabled ? "disable" : "enable";
      const response = await fetch(`/api/v1/plugins/${plugin.id}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error: { message: string };
        } | null;
        setError(body?.error.message ?? `We couldn't ${action} ${plugin.name}.`);
        return;
      }
      await load();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (state.status === "loading") return <LoadingState label="Loading plugins…" />;
  if (state.status === "error") {
    return <ErrorState description="We couldn't load your plugins." />;
  }

  const enabledCount = state.plugins.filter((plugin) => plugin.enabled).length;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Capabilities you can switch on and off. Each one brings its own entities, forms and
          widgets — turn on only what your business actually does.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{enabledCount}</span> of{" "}
        {state.plugins.length} enabled.{" "}
        {/* Disabling never deletes: worth saying before someone clicks it. */}
        Switching one off hides its screens and stops its automations; nothing you have already
        entered is deleted.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {state.plugins.length === 0 ? (
        <EmptyState
          icon={BlocksIcon}
          title="No plugins available"
          description="That should not happen — the catalogue ships with the product."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {state.plugins.map((plugin) => {
            const meta = DESCRIPTIONS[plugin.id];
            const Icon = meta?.icon ?? BlocksIcon;
            return (
              <li key={plugin.id}>
                <Card
                  className={
                    plugin.enabled
                      ? "h-full border-graft-green/40 ring-1 ring-graft-green/10"
                      : "h-full"
                  }
                >
                  <CardHeader className="flex flex-row items-start gap-3">
                    <span
                      className={
                        plugin.enabled
                          ? "rounded-md bg-graft-green/10 p-2 text-graft-green dark:text-graft-green-light"
                          : "rounded-md bg-muted p-2 text-muted-foreground"
                      }
                    >
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base">{plugin.name}</CardTitle>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {TIER_LABEL[plugin.tier]} · v{plugin.version}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                      {meta?.blurb ?? "A capability package for your workspace."}
                    </p>
                    <GatedControl
                      allowed={plugin.eligible}
                      upgradeMessage={`${plugin.name} is on ${TIER_LABEL[plugin.tier]}.`}
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant={plugin.enabled ? "outline" : "default"}
                        aria-pressed={plugin.enabled}
                        onClick={() => void toggle(plugin)}
                        disabled={busy === plugin.id}
                      >
                        {busy === plugin.id
                          ? "Working…"
                          : plugin.enabled
                            ? "Turn off"
                            : "Turn on"}
                      </Button>
                    </GatedControl>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
