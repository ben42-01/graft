"use client";

/**
 * The customer-facing half of catalogue mode — step one of the public form:
 * find the thing you want, and pick it.
 *
 * Built for a catalogue of five and of ten thousand alike:
 *
 *   - **Row by row, picture first.** Each resource is one row — its photo, its
 *     name, its public details — in a list that scrolls with the page, which
 *     is how people already browse products on a phone. The row *is* the
 *     button: there is no separate "select" control to miss.
 *   - **Pages are fetched, never inlined, and only as the list is used.** A
 *     sentinel below the last row asks for the next page as it nears the
 *     viewport, with the cursor the server issued; the server caps the page
 *     size regardless. A "Show more" button does the same for anyone (or any
 *     browser) the sentinel does not reach. Ten thousand resources cost ten
 *     thousand rows only for a visitor who scrolls past all of them.
 *   - **Search, when there is something to search.** The server says which
 *     field a search matches (the row's name) and the box appears only then.
 *     A search asks the server again rather than filtering what is loaded, so
 *     it finds item 9,000 as readily as item 9.
 *   - **Choosing hands off, it does not toggle.** Picking a row reports the
 *     whole card upward, and the form takes over from there — hiding this
 *     list, showing the chosen resource and the questions about it. The list
 *     stays mounted while hidden so "Change" returns to the same search and
 *     scroll position.
 *   - **It degrades to the form.** An empty catalogue or a failed first fetch
 *     calls `onUnavailable`, and the form shows its fields without a step
 *     one. A catalogue is an enhancement to a form, never a gate in front of
 *     one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, ImageIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { contrastingTextColor } from "@/lib/contrast";

export type CatalogueCard = {
  id: string;
  image: { url: string; alt: string } | null;
  values: { key: string; label: string; value: string }[];
};

type Page = {
  data: CatalogueCard[];
  meta: { cursor: string | null; searchLabel?: string | null };
};

type State =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      cards: CatalogueCard[];
      cursor: string | null;
      /** The search these cards answer; `""` for the whole catalogue. */
      query: string;
      failed: boolean;
    };

/** How long typing has to pause before a search is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/** Start fetching the next page this far before the visitor reaches it. */
const PREFETCH_MARGIN = "600px";

export const nameOf = (card: CatalogueCard) => card.values[0]?.value || "This item";

export function CatalogueBrowser({
  tenantSlug,
  formSlug,
  accent,
  onSelect,
  onUnavailable,
}: {
  tenantSlug: string;
  formSlug: string;
  /** The tenant's brand colour, or Graft's own. */
  accent: string;
  onSelect: (card: CatalogueCard) => void;
  /** Nothing to choose from — empty, or the first page failed. */
  onUnavailable?: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [searchLabel, setSearchLabel] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const reportedRef = useRef(false);

  const base = `/api/v1/public/forms/${tenantSlug}/${formSlug}/catalogue`;

  const fetchPage = useCallback(
    async (cursor: string | null, q: string): Promise<Page | null> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (q) params.set("q", q);
      const qs = params.toString();
      try {
        // `credentials: "omit"` for the same reason the submit path uses it:
        // this page reads no cookie and must issue none.
        const response = await fetch(qs ? `${base}?${qs}` : base, { credentials: "omit" });
        if (!response.ok) return null;
        return (await response.json()) as Page;
      } catch {
        return null;
      }
    },
    [base],
  );

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    let cancelled = false;
    void fetchPage(null, query).then((body) => {
      if (cancelled) return;
      if (!body) {
        // The first load failing hides the catalogue; a search failing must
        // not, or the visitor loses the box they were typing into.
        setState((prev) =>
          query === "" && prev.status !== "ready"
            ? { status: "error" }
            : { status: "ready", cards: [], cursor: null, query, failed: true },
        );
        return;
      }
      if (body.meta.searchLabel !== undefined) setSearchLabel(body.meta.searchLabel);
      setState({
        status: "ready",
        cards: body.data,
        cursor: body.meta.cursor,
        query,
        failed: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, query]);

  const unavailable =
    state.status === "error" ||
    (state.status === "ready" &&
      state.cards.length === 0 &&
      state.query === "" &&
      search.trim() === "" &&
      !state.failed);

  useEffect(() => {
    if (unavailable && !reportedRef.current) {
      reportedRef.current = true;
      onUnavailable?.();
    }
  }, [unavailable, onUnavailable]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.cursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const forQuery = state.query;
    const body = await fetchPage(state.cursor, forQuery);
    loadingRef.current = false;
    setLoadingMore(false);
    if (!body) return;
    setState((prev) =>
      // A search that started meanwhile owns the list now.
      prev.status === "ready" && prev.query === forQuery
        ? { ...prev, cards: [...prev.cards, ...body.data], cursor: body.meta.cursor }
        : prev,
    );
  }, [state, fetchPage]);

  // Infinite scroll. Where IntersectionObserver is missing the "Show more"
  // button below is the whole mechanism, which is also what a keyboard or
  // screen-reader user is offered.
  const hasMore = state.status === "ready" && state.cursor !== null;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  if (unavailable) return null;
  if (state.status !== "ready") {
    return (
      <ul aria-label="Loading items" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex gap-4 rounded-xl border p-3">
            <span className="aspect-4/3 w-24 shrink-0 animate-pulse rounded-lg bg-muted sm:w-36" />
            <span className="flex flex-1 flex-col gap-2 py-1">
              <span className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              <span className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  const searchName = searchLabel ? `Search by ${searchLabel.toLowerCase()}` : null;

  return (
    <section aria-label="What we offer" className="flex flex-col gap-3">
      {searchName ? (
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={searchName}
            placeholder={`${searchName}…`}
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="h-11 rounded-xl pl-9"
          />
        </div>
      ) : null}

      {state.cards.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {state.failed
            ? "We couldn't search just now. Try again in a moment."
            : `Nothing matches “${state.query}”.`}
        </p>
      ) : (
        <ul aria-label="Items" className="flex flex-col gap-3">
          {state.cards.map((card) => (
            <li key={card.id}>
              <ResourceRow card={card} accent={accent} onChoose={() => onSelect(card)} />
            </li>
          ))}
        </ul>
      )}

      <div ref={sentinelRef} aria-hidden="true" />

      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="self-center rounded-full"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Show more"}
        </Button>
      ) : null}

      <p aria-live="polite" className="text-center text-xs text-muted-foreground">
        {state.cards.length.toLocaleString()} shown{hasMore ? " · scroll for more" : ""}
      </p>
    </section>
  );
}

/**
 * One resource. Also used, without `onChoose`, as the summary of the chosen
 * one above the form fields — the same row, so the visitor recognises it.
 */
export function ResourceRow({
  card,
  accent,
  onChoose,
  trailing,
}: {
  card: CatalogueCard;
  accent: string;
  onChoose?: () => void;
  /** Replaces the chevron — the chosen row puts its "Change" button here. */
  trailing?: React.ReactNode;
}) {
  const [name, ...details] = card.values;
  const body = (
    <>
      <span className="flex aspect-4/3 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted sm:w-36">
        {card.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- the byte route 307s to a presigned URL; next/image cannot follow that
          <img
            src={card.image.url}
            alt={card.image.alt}
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <ImageIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
        <span className="line-clamp-2 text-base leading-snug font-semibold">
          {name?.value || "Untitled"}
        </span>
        {details.length > 0 ? (
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {details
              .filter((value) => value.value !== "")
              .map((value) => (
                <span key={value.key} className="min-w-0">
                  <span className="text-muted-foreground/80">{value.label}</span>{" "}
                  <span className="font-medium text-foreground">{value.value}</span>
                </span>
              ))}
          </span>
        ) : null}
      </span>

      {trailing ?? (
        <span
          className="flex size-8 shrink-0 items-center justify-center self-center rounded-full border border-(--accent) text-(--accent) transition-colors group-hover:bg-(--accent) group-hover:text-(--accent-fg)"
          style={
            {
              "--accent": accent,
              "--accent-fg": contrastingTextColor(accent),
            } as React.CSSProperties
          }
          aria-hidden="true"
        >
          <ChevronRightIcon className="size-4" />
        </span>
      )}
    </>
  );

  const shell =
    "group flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-left sm:gap-4";
  if (!onChoose) return <div className={shell}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-label={`Choose ${name?.value || "this item"}`}
      className={`${shell} transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
    >
      {body}
    </button>
  );
}
