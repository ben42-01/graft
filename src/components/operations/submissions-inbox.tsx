"use client";

/**
 * The inbox — what came in through your forms, newest first: who sent it,
 * which form, and the order it raised. Before this a submission was only
 * findable as a row in whichever entity the form wrote to.
 *
 * `limit` turns it into the short "Latest activity" feed on the Overview;
 * without one it is the full, pageable list on Operations.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { InboxIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { formatMoney, formatRelative, orderNumber } from "@/lib/bms/format";
import { customerLabel, type ApiSubmission } from "@/lib/bms/reads";
import { StatusBadge } from "./status-badge";

type Page = { items: ApiSubmission[]; cursor: string | null };
type State = { status: "loading" } | { status: "error" } | ({ status: "ready" } & Page);

async function fetchPage(limit: number, cursor?: string | null): Promise<Page | null> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/v1/submissions?${params}`, { credentials: "include" });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data: ApiSubmission[];
      meta: { hasMore: boolean; cursor: string | null };
    };
    return { items: body.data, cursor: body.meta.hasMore ? body.meta.cursor : null };
  } catch {
    return null;
  }
}

export function SubmissionRow({ submission }: { submission: ApiSubmission }) {
  const who = customerLabel(submission.customer) ?? "Someone";
  const { order } = submission;
  const href = order
    ? `/operations/orders/${order.id}`
    : submission.customer
      ? `/entities/${submission.customer.entityId}`
      : null;

  return (
    <li className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm">
          {href ? (
            <Link href={href} className="font-medium underline-offset-4 hover:underline">
              {who}
            </Link>
          ) : (
            <span className="font-medium">{who}</span>
          )}{" "}
          <span className="text-muted-foreground">
            {order ? "ordered through" : "submitted"} {submission.form.name ?? "a form"}
          </span>
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {formatRelative(submission.createdAt)}
          {submission.customer?.email ? ` · ${submission.customer.email}` : ""}
          {order ? ` · ${orderNumber(order.id)}` : ""}
        </p>
      </div>
      {order ? (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-medium tabular-nums">
            {formatMoney(order.totalMinor, order.currency)}
          </span>
          <StatusBadge status={order.status} />
        </div>
      ) : null}
    </li>
  );
}

export function SubmissionsInbox({ limit }: { limit?: number }) {
  const pageSize = limit ?? 25;
  const [state, setState] = useState<State>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPage(pageSize).then((page) => {
      if (cancelled) return;
      setState(page ? { status: "ready", ...page } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [pageSize]);

  const more = useCallback(async () => {
    if (state.status !== "ready" || !state.cursor) return;
    setLoadingMore(true);
    const page = await fetchPage(pageSize, state.cursor);
    setLoadingMore(false);
    if (!page) return;
    setState({ status: "ready", items: [...state.items, ...page.items], cursor: page.cursor });
  }, [pageSize, state]);

  if (state.status === "loading") return <LoadingState label="Loading submissions…" />;
  if (state.status === "error") {
    return limit ? (
      <p className="text-sm text-muted-foreground">Latest activity is unavailable.</p>
    ) : (
      <ErrorState description="We couldn't load your submissions." />
    );
  }

  if (state.items.length === 0) {
    return limit ? (
      <p className="py-2 text-sm text-muted-foreground">
        Nothing has come in yet. Publish a form and submissions land here.
      </p>
    ) : (
      <EmptyState
        icon={InboxIcon}
        title="Nothing has come in yet"
        description="Every form submission appears here, with who sent it and the order it raised."
        action={
          <Button asChild size="sm">
            <Link href="/forms">Open forms</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y">
        {state.items.map((submission) => (
          <SubmissionRow key={submission.id} submission={submission} />
        ))}
      </ul>
      {!limit && state.cursor ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          loading={loadingMore}
          onClick={() => void more()}
        >
          Show older
        </Button>
      ) : null}
    </div>
  );
}
