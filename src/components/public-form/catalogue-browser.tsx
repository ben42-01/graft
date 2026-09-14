"use client";

/**
 * The customer-facing half of catalogue mode — find what a business offers,
 * pick one, then fill in the form about it.
 *
 * Built for a catalogue of five and of five thousand alike:
 *
 *   - **One row, never a wall.** Cards sit in a single swipeable row with
 *     previous and next controls, so the form below is always a short scroll
 *     away however much a business rents out. This used to lay every loaded
 *     card out in a grid, which put five boats — or five hundred — between
 *     the visitor and the form.
 *   - **Pages are fetched, never inlined, and only as the row is used.** The
 *     next page is asked for when the visitor reaches the end of the row, with
 *     the cursor the server issued; the server caps the page size regardless.
 *   - **Search, when there is something to search.** The server says which
 *     field a search matches (the card's name) and the box appears only then.
 *     A search asks the server again rather than filtering what happens to be
 *     loaded, so it finds item 900 as readily as item 9.
 *   - **Selecting is a real, reversible choice that stays visible.** The
 *     chosen item is named above the row, so it doesn't vanish when the row
 *     scrolls on or a search replaces it, and it can be cleared.
 *   - **It degrades to nothing.** An empty catalogue or a failed first fetch
 *     leaves the form itself working. A catalogue is an enhancement to a
 *     form, never a gate in front of one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { contrastingTextColor } from "@/lib/contrast";
import { cn } from "@/lib/utils";

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

const nameOf = (card: CatalogueCard) => card.values[0]?.value ?? "this item";

/** Within half a screen of the end of the row — time to fetch the next page. */
const nearEnd = (el: HTMLElement) =>
  el.scrollLeft + el.clientWidth >= el.scrollWidth - el.clientWidth / 2;

export function CatalogueBrowser({
  tenantSlug,
  formSlug,
  selectedId,
  onSelect,
  primaryColor,
}: {
  tenantSlug: string;
  formSlug: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  primaryColor: string | null;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [searchLabel, setSearchLabel] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  // The chosen card itself, so its name survives a search that replaces the row.
  const [chosen, setChosen] = useState<CatalogueCard | null>(null);
  const loadingRef = useRef(false);
  const rowRef = useRef<HTMLUListElement>(null);

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
      rowRef.current?.scrollTo?.({ left: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, query]);

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
      // A search that started meanwhile owns the row now.
      prev.status === "ready" && prev.query === forQuery
        ? { ...prev, cards: [...prev.cards, ...body.data], cursor: body.meta.cursor }
        : prev,
    );
  }, [state, fetchPage]);

  function step(direction: 1 | -1) {
    const row = rowRef.current;
    if (!row) return;
    if (direction === 1 && nearEnd(row)) void loadMore();
    row.scrollBy?.({ left: direction * row.clientWidth * 0.9, behavior: "smooth" });
  }

  function choose(card: CatalogueCard) {
    const clearing = card.id === selectedId;
    setChosen(clearing ? null : card);
    onSelect(clearing ? null : card.id);
  }

  // A catalogue that cannot load is not an error the visitor can act on, and
  // the form below still works — so it says nothing at all.
  if (state.status === "error") return null;
  if (state.status === "loading") {
    return <p className="text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (state.cards.length === 0 && state.query === "" && search.trim() === "" && !state.failed) {
    return null;
  }

  const selectedName = selectedId
    ? chosen?.id === selectedId
      ? nameOf(chosen)
      : (state.cards.find((card) => card.id === selectedId) ?? null)?.values[0]?.value
    : null;

  const selectedStyle = primaryColor
    ? { borderColor: primaryColor, boxShadow: `0 0 0 1px ${primaryColor}` }
    : undefined;

  const searchName = searchLabel ? `Search by ${searchLabel.toLowerCase()}` : null;

  return (
    <section aria-label="What we offer" className="flex flex-col gap-3">
      {searchName ? (
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={searchName}
            placeholder={`${searchName}…`}
            value={search}
            maxLength={60}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-8"
          />
        </div>
      ) : null}

      {selectedId && selectedName ? (
        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
          <span className="min-w-0 truncate">
            Selected: <strong>{selectedName}</strong>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setChosen(null);
              onSelect(null);
            }}
          >
            <XIcon /> Clear
          </Button>
        </div>
      ) : null}

      {state.cards.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {state.failed
            ? "We couldn't search just now. Try again in a moment."
            : `Nothing matches “${state.query}”.`}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <ul
            ref={rowRef}
            aria-label="Items"
            onScroll={(event) => {
              if (nearEnd(event.currentTarget)) void loadMore();
            }}
            className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-2"
          >
            {state.cards.map((card) => {
              const selected = card.id === selectedId;
              return (
                <li key={card.id} className="w-[46%] shrink-0 snap-start sm:w-[31%]">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => choose(card)}
                    style={selected ? selectedStyle : undefined}
                    className={cn(
                      "relative flex h-full w-full flex-col overflow-hidden rounded-lg border text-left transition-colors",
                      selected
                        ? "border-foreground"
                        : "border-border hover:border-foreground/40",
                    )}
                  >
                    <span className="flex aspect-4/3 w-full items-center justify-center bg-muted">
                      {card.image ? (
                        // eslint-disable-next-line @next/next/no-img-element -- the byte route 307s to a presigned URL; next/image cannot follow that
                        <img
                          src={card.image.url}
                          alt={card.image.alt}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : (
                        <ImageIcon
                          className="size-6 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </span>

                    <span className="flex flex-col gap-0.5 p-3">
                      {card.values.map((value, index) => (
                        <span
                          key={value.key}
                          className={cn(
                            "truncate",
                            index === 0
                              ? "text-sm font-medium"
                              : "text-xs text-muted-foreground",
                          )}
                        >
                          {/* The first value is the name; the rest are details,
                           * and their labels earn their space from the second
                           * row down where "£120" alone would be ambiguous. */}
                          {index === 0 ? value.value : `${value.label}: ${value.value}`}
                        </span>
                      ))}
                    </span>

                    {selected ? (
                      <span
                        // The ring is load-bearing, not decoration: the badge
                        // sits on a photo nobody here controls, and a brand
                        // colour that matches it would hide the selection.
                        className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm ring-2 ring-white"
                        style={
                          primaryColor
                            ? {
                                backgroundColor: primaryColor,
                                color: contrastingTextColor(primaryColor),
                              }
                            : undefined
                        }
                        aria-hidden="true"
                      >
                        <CheckIcon className="size-3" />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {loadingMore ? (
              <li className="flex w-24 shrink-0 items-center justify-center text-xs text-muted-foreground">
                Loading…
              </li>
            ) : null}
          </ul>

          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Previous items"
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <p className="text-xs text-muted-foreground">
              {state.cards.length.toLocaleString()} shown
              {state.cursor ? " · swipe for more" : ""}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Next items"
              disabled={loadingMore}
              onClick={() => step(1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      )}

      <p aria-live="polite" className="text-center text-xs text-muted-foreground">
        {selectedId
          ? "Selected — now fill in your details below."
          : "Pick one to enquire about it, or just fill in the form below."}
      </p>
    </section>
  );
}
