"use client";

/**
 * The admin console's client data layer: one fetch helper and two hooks,
 * shared by every screen added with the sidebar console (dashboard, users,
 * entities, subscriptions, audit, activity monitor).
 *
 * The original GRAFT-27 table (tenant-table.tsx) keeps
 * its own hand-rolled fetch/State machinery — it is contract code with
 * its own tests, and nothing is gained by re-plumbing it.
 *
 * Every read goes through the caller's own session cookie. The server decides
 * what is visible (`assertPlatformAdmin`); this file only decides how a wait
 * and a failure look. A 401 is retried once after a refresh, because the
 * access token is short-lived and an admin tab is often left open.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type PageMeta = { cursor: string | null; hasMore: boolean; limit?: number };

export type Params = Record<string, string | undefined | null | false>;

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function buildUrl(path: string, params: Params = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function refresh(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function adminGet<T>(
  path: string,
  params: Params = {},
): Promise<{ data: T; meta: PageMeta }> {
  return adminGetUrl<T>(buildUrl(path, params));
}

/** Appends one more query parameter to an already-built URL. */
const withParam = (url: string, key: string, value: string) =>
  `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

async function adminGetUrl<T>(url: string): Promise<{ data: T; meta: PageMeta }> {
  let response = await fetch(url, { credentials: "include" });
  if (response.status === 401 && (await refresh())) {
    response = await fetch(url, { credentials: "include" });
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not JSON — keep the status message.
    }
    throw new AdminApiError(response.status, message);
  }
  const body = (await response.json()) as { data: T; meta: PageMeta };
  return body;
}

type QueryState<T> =
  | { status: "loading"; data: T | null }
  | { status: "error"; data: T | null; error: string }
  | { status: "ready"; data: T };

/**
 * One GET, re-run whenever `key` changes. `data` is kept across reloads so a
 * refresh or a filter change does not blank the screen while it is in flight.
 */
export function useAdminQuery<T>(path: string, params: Params = {}, pollMs?: number) {
  const key = buildUrl(path, params);
  const [state, setState] = useState<QueryState<T>>({ status: "loading", data: null });
  const [refreshing, setRefreshing] = useState(false);

  // `key` is the request's whole identity (path + params), so it is the only
  // dependency the loaders need.
  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setRefreshing(true);
      try {
        const body = await adminGetUrl<T>(key);
        if (!signal.cancelled) setState({ status: "ready", data: body.data });
      } catch (error) {
        if (!signal.cancelled)
          setState((prev) => ({
            status: "error",
            data: prev.data,
            error: error instanceof Error ? error.message : "Request failed",
          }));
      } finally {
        if (!signal.cancelled) setRefreshing(false);
      }
    },
    [key],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    const timer = pollMs ? setInterval(() => void load(signal), pollMs) : undefined;
    return () => {
      signal.cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [load, pollMs]);

  const reload = useCallback(() => void load({ cancelled: false }), [load]);
  return { ...state, refreshing, reload };
}

type ListState<T> =
  | { status: "loading"; rows: T[] }
  | { status: "error"; rows: T[]; error: string }
  | { status: "ready"; rows: T[]; cursor: string | null; hasMore: boolean };

/**
 * A cursor-paged list: first page on every filter change, "load more" appends
 * the next page and de-duplicates by id, and a response that arrives after the
 * filters moved on is dropped rather than painted over the newer one.
 */
export function useAdminList<T extends { id: string }>(path: string, params: Params = {}) {
  const key = buildUrl(path, params);
  const [state, setState] = useState<ListState<T>>({ status: "loading", rows: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const loadFirst = useCallback(async () => {
    const forKey = key;
    setState((prev) => ({ status: "loading", rows: prev.rows }));
    try {
      const body = await adminGetUrl<T[]>(key);
      if (keyRef.current !== forKey) return;
      setState({
        status: "ready",
        rows: body.data,
        cursor: body.meta.cursor,
        hasMore: body.meta.hasMore,
      });
    } catch (error) {
      if (keyRef.current !== forKey) return;
      setState({
        status: "error",
        rows: [],
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }, [key]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.hasMore || !state.cursor || loadingMore) return;
    const forKey = key;
    setLoadingMore(true);
    try {
      const body = await adminGetUrl<T[]>(withParam(key, "cursor", state.cursor));
      if (keyRef.current !== forKey) return;
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        const seen = new Set(prev.rows.map((row) => row.id));
        return {
          status: "ready",
          rows: [...prev.rows, ...body.data.filter((row) => !seen.has(row.id))],
          cursor: body.meta.cursor,
          hasMore: body.meta.hasMore,
        };
      });
    } catch {
      // A failed "more" leaves what is on screen alone; the button stays to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [state, key, loadingMore]);

  return {
    ...state,
    hasMore: state.status === "ready" && state.hasMore,
    loadingMore,
    loadMore,
    reload: loadFirst,
  };
}

/** Debounces a text input into a query value — same 300ms the original tables use. */
export function useDebounced(value: string, ms = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
