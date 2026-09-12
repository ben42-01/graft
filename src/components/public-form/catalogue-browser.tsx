"use client";

/**
 * The customer-facing half of catalogue mode — browse what a business sells,
 * pick one, then fill in the form about it.
 *
 * Three things shape it:
 *
 *   - **Pages are fetched, never inlined.** The server component ships the
 *     catalogue's *shape*, and the cards arrive one page at a time from
 *     `/api/v1/public/forms/:tenantSlug/:formSlug/catalogue`. A shared link
 *     to a business with four hundred products must not put four hundred
 *     products in the initial HTML, and the endpoint caps the page size
 *     regardless of what this asks for.
 *   - **Selecting is a real, reversible choice.** The chosen card stays
 *     visible and can be cleared, because "which one did I pick" is the
 *     question a visitor will have when they reach the fields below, and a
 *     silent selection that scrolls out of view answers it badly.
 *   - **It degrades to nothing.** An empty catalogue, a failed fetch or a
 *     business that has not photographed anything yet all leave the form
 *     itself working — the visitor can still get in touch. A catalogue is an
 *     enhancement to a form, never a gate in front of one.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { contrastingTextColor } from "@/lib/contrast";
import { cn } from "@/lib/utils";

export type CatalogueCard = {
  id: string;
  image: { url: string; alt: string } | null;
  values: { key: string; label: string; value: string }[];
};

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; cards: CatalogueCard[]; cursor: string | null };

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
  const [loadingMore, setLoadingMore] = useState(false);

  const base = `/api/v1/public/forms/${tenantSlug}/${formSlug}/catalogue`;

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      // `credentials: "omit"` for the same reason the submit path uses it:
      // this page reads no cookie and must issue none.
      const response = await fetch(cursor ? `${base}?cursor=${cursor}` : base, {
        credentials: "omit",
      });
      if (!response.ok) return null;
      return (await response.json()) as {
        data: CatalogueCard[];
        meta: { cursor: string | null };
      };
    },
    [base],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchPage(null).then((body) => {
      if (cancelled) return;
      setState(
        body
          ? { status: "ready", cards: body.data, cursor: body.meta.cursor }
          : { status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function loadMore() {
    if (state.status !== "ready" || !state.cursor) return;
    setLoadingMore(true);
    const body = await fetchPage(state.cursor);
    setLoadingMore(false);
    if (!body) return;
    setState({
      status: "ready",
      cards: [...state.cards, ...body.data],
      cursor: body.meta.cursor,
    });
  }

  // A catalogue that cannot load is not an error the visitor can act on, and
  // the form below still works — so it says nothing at all.
  if (state.status === "error") return null;
  if (state.status === "loading") {
    return <p className="text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (state.cards.length === 0) return null;

  const selectedStyle = primaryColor
    ? { borderColor: primaryColor, boxShadow: `0 0 0 1px ${primaryColor}` }
    : undefined;

  return (
    <section aria-label="What we offer" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {state.cards.map((card) => {
          const selected = card.id === selectedId;
          return (
            <button
              key={card.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : card.id)}
              style={selected ? selectedStyle : undefined}
              className={cn(
                "relative flex flex-col overflow-hidden rounded-lg border text-left transition-colors",
                selected ? "border-foreground" : "border-border hover:border-foreground/40",
              )}
            >
              <span className="flex aspect-4/3 w-full items-center justify-center bg-muted">
                {card.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the byte route 307s to a presigned URL; next/image cannot follow that
                  <img
                    src={card.image.url}
                    alt={card.image.alt}
                    className="size-full object-cover"
                  />
                ) : (
                  <ImageIcon className="size-6 text-muted-foreground" aria-hidden="true" />
                )}
              </span>

              <span className="flex flex-col gap-0.5 p-3">
                {card.values.map((value, index) => (
                  <span
                    key={value.key}
                    className={cn(
                      "truncate",
                      index === 0 ? "text-sm font-medium" : "text-xs text-muted-foreground",
                    )}
                  >
                    {/* The first value is the name; the rest are details, and
                     * their labels only earn their space from the second row
                     * down where "£120" alone would be ambiguous. */}
                    {index === 0 ? value.value : `${value.label}: ${value.value}`}
                  </span>
                ))}
              </span>

              {selected ? (
                <span
                  // The ring is load-bearing, not decoration: the badge sits
                  // on top of a photo nobody here controls, and a brand colour
                  // that happens to match it would make the selection
                  // invisible. A white ring separates it from any image.
                  className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-foreground text-background ring-2 ring-white shadow-sm"
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
          );
        })}
      </div>

      {state.cursor ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Show more"}
        </Button>
      ) : null}

      <p aria-live="polite" className="text-center text-xs text-muted-foreground">
        {selectedId
          ? "Selected — now fill in your details below."
          : "Pick one to enquire about it, or just fill in the form below."}
      </p>
    </section>
  );
}
