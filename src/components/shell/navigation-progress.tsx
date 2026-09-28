"use client";

/**
 * A thin bar across the top of the viewport while a client-side navigation is
 * in flight. The App Router exposes no "navigation started" event, so the
 * start is a click on a same-origin link that leads somewhere else; the end is
 * the URL (path or query) actually changing. A safety timeout clears the bar
 * if a navigation is cancelled or never lands.
 */
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

const SAFETY_TIMEOUT_MS = 15_000;
/** How long the "done" state (full width, fading out) stays up. */
const FINISH_MS = 500;

type Phase = "idle" | "loading" | "done";

/** The link a click would follow client-side, or null if it wouldn't. */
export function navigationTarget(event: MouseEvent, location: Location): URL | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;

  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return null;
  // Same page (or an in-page #anchor) — nothing will load.
  if (url.pathname === location.pathname && url.search === location.search) return null;
  return url;
}

function Bar() {
  const pathname = usePathname();
  // Keyed by value, not object identity — a re-render must not end the bar.
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<Phase>("idle");
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!navigationTarget(event, window.location)) return;
      setPhase("loading");
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setPhase("idle"), SAFETY_TIMEOUT_MS);
    };
    // Bubble phase, so a handler that calls preventDefault() has already run.
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    clearTimeout(timeout.current);
    setPhase((current) => (current === "loading" ? "done" : current));
    timeout.current = setTimeout(() => setPhase("idle"), FINISH_MS);
    return () => clearTimeout(timeout.current);
  }, [pathname, search]);

  return (
    <div
      aria-hidden="true"
      data-phase={phase}
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
    >
      <div
        className={
          phase === "loading"
            ? "h-full w-full origin-left animate-[graft-nav-progress_8s_cubic-bezier(0.1,0.7,0.2,1)_forwards] bg-graft-green"
            : phase === "done"
              ? "h-full w-full origin-left bg-graft-green opacity-0 transition-opacity delay-150 duration-300"
              : "hidden"
        }
      />
    </div>
  );
}

export function NavigationProgress() {
  // useSearchParams() needs a Suspense boundary to keep static pages static.
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}
