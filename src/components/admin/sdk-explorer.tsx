"use client";

/**
 * `/admin/sdk` — an in-browser API client over every endpoint Graft exposes.
 * Pick a service and an endpoint from the catalogue (generated from the route
 * files, with the Bruno collection's requests attached as ready-made
 * examples), fill in path params, query and body, and run it.
 *
 * Requests are ordinary same-origin `fetch` calls with the admin's own session
 * cookie — this page has no privilege of its own. Tenant endpoints therefore
 * act on the admin's *current* workspace, admin endpoints on the platform, and
 * a pasted bearer token (optional) runs a request as whoever it belongs to.
 * Mutating methods are real writes; the page says so before it sends one.
 *
 * History is per-browser (sessionStorage) and never leaves the machine.
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CopyIcon,
  GlobeIcon,
  HistoryIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  API_CATALOGUE,
  type CatalogueEndpoint,
  type HttpMethod,
} from "@/lib/admin/api-catalogue";
import { cn } from "@/lib/utils";
import { CopyButton, PageHeader, Pill } from "./admin-ui";

const METHOD_STYLE: Record<HttpMethod, string> = {
  GET: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  POST: "bg-graft-green/10 text-graft-green-deep dark:text-graft-green-light",
  PUT: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  PATCH: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  DELETE: "bg-destructive/10 text-destructive",
};

export function MethodBadge({ method, className }: { method: HttpMethod; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex w-14 shrink-0 justify-center rounded px-1 py-0.5 font-mono text-[10px] font-bold tracking-wide",
        METHOD_STYLE[method],
        className,
      )}
    >
      {method}
    </span>
  );
}

const AUTH_META = {
  "platform-admin": { label: "Platform admin", icon: ShieldCheckIcon, tone: "indigo" as const },
  session: { label: "Signed-in user", icon: LockIcon, tone: "green" as const },
  public: { label: "Public", icon: GlobeIcon, tone: "neutral" as const },
};

type QueryRow = { key: string; value: string };

type Draft = {
  pathParams: Record<string, string>;
  query: QueryRow[];
  body: string;
};

type ResponseView = {
  status: number;
  statusText: string;
  ms: number;
  size: number;
  headers: [string, string][];
  body: string;
  isJson: boolean;
};

type HistoryEntry = {
  at: string;
  endpointId: string;
  url: string;
  status: number;
  ms: number;
  draft: Draft;
};

const HISTORY_KEY = "graft.admin.sdk.history";
const MAX_HISTORY = 25;

const hasBody = (method: HttpMethod) => method !== "GET" && method !== "DELETE";

function emptyDraft(endpoint: CatalogueEndpoint): Draft {
  return {
    pathParams: Object.fromEntries(endpoint.params.map((p) => [p, ""])),
    query: [{ key: "", value: "" }],
    body: hasBody(endpoint.method) ? "{\n  \n}" : "",
  };
}

export function buildRequestUrl(endpoint: CatalogueEndpoint, draft: Draft): string {
  const path = endpoint.path.replace(/:([A-Za-z0-9_]+)\*?/g, (_, name: string) =>
    encodeURIComponent(draft.pathParams[name] ?? "").replace(/%2F/g, "/"),
  );
  const search = new URLSearchParams();
  for (const row of draft.query) if (row.key.trim()) search.set(row.key.trim(), row.value);
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

function readHistory(): HistoryEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
  } catch {
    return [];
  }
}

function writeHistory(entries: HistoryEntry[]) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {
    // Storage blocked — history is a convenience, not a requirement.
  }
}

/** Tiny JSON highlighter — tokens only, no parsing; safe because React escapes text. */
function JsonView({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: { text: string; cls?: string }[] = [];
    const re =
      /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0;
    for (const match of text.matchAll(re)) {
      const index = match.index ?? 0;
      if (index > last) out.push({ text: text.slice(last, index) });
      const token = match[0];
      const cls = token.startsWith('"')
        ? match[2]
          ? "text-graft-indigo dark:text-indigo-300"
          : "text-graft-green-deep dark:text-graft-green-light"
        : /true|false|null/.test(token)
          ? "text-amber-700 dark:text-amber-300"
          : "text-blue-700 dark:text-blue-300";
      out.push({ text: token, cls });
      last = index + token.length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }, [text]);
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed">
      {parts.map((part, index) =>
        part.cls ? (
          <span key={index} className={part.cls}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </pre>
  );
}

function curlFor(method: HttpMethod, url: string, body: string, token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const lines = [`curl -X ${method} '${origin}${url}'`];
  lines.push(
    token
      ? `  -H 'Authorization: Bearer ${token}'`
      : "  -H 'Authorization: Bearer $GRAFT_TOKEN'",
  );
  if (hasBody(method) && body.trim()) {
    lines.push("  -H 'Content-Type: application/json'");
    lines.push(`  --data '${body.replace(/'/g, "'\\''")}'`);
  }
  return lines.join(" \\\n");
}

export function SdkExplorer() {
  const searchParams = useSearchParams();
  const groups = useMemo(() => [...new Set(API_CATALOGUE.map((e) => e.group))].sort(), []);
  const [group, setGroup] = useState("all");
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string>(
    () =>
      searchParams.get("endpoint") ??
      API_CATALOGUE.find((e) => e.path === "/api/v1/me")?.id ??
      API_CATALOGUE[0]?.id ??
      "",
  );
  const endpoint = API_CATALOGUE.find((e) => e.id === selectedId) ?? API_CATALOGUE[0]!;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(endpoint));
  const [token, setToken] = useState("");
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ResponseView | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  const sendRef = useRef<() => void>(() => {});

  useEffect(() => setHistory(readHistory()), []);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return API_CATALOGUE.filter(
      (e) =>
        (group === "all" || e.group === group) &&
        (!needle ||
          e.path.toLowerCase().includes(needle) ||
          e.method.toLowerCase() === needle ||
          e.summary.toLowerCase().includes(needle)),
    );
  }, [group, filter]);

  const select = (next: CatalogueEndpoint, withDraft?: Draft) => {
    setSelectedId(next.id);
    setDraft(withDraft ?? emptyDraft(next));
    setResponse(null);
    setRequestError(null);
  };

  const loadExample = (index: number) => {
    const example = endpoint.examples[index];
    if (!example) return;
    const query = Object.entries(example.query).map(([key, value]) => ({ key, value }));
    setDraft({
      pathParams: { ...emptyDraft(endpoint).pathParams, ...example.pathParams },
      query: query.length > 0 ? query : [{ key: "", value: "" }],
      body: example.body ?? (hasBody(endpoint.method) ? "{\n  \n}" : ""),
    });
  };

  const url = buildRequestUrl(endpoint, draft);
  const missingParams = endpoint.params.filter((p) => !draft.pathParams[p]?.trim());
  let bodyError: string | null = null;
  if (hasBody(endpoint.method) && draft.body.trim()) {
    try {
      JSON.parse(draft.body);
    } catch (error) {
      bodyError = error instanceof Error ? error.message : "Invalid JSON";
    }
  }
  const unfilledVars = /\{\{[^}]+\}\}/.test(url + draft.body);
  const canSend = !sending && missingParams.length === 0 && !bodyError;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setRequestError(null);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    const withBody = hasBody(endpoint.method) && draft.body.trim() !== "";
    if (withBody) headers["Content-Type"] = "application/json";
    const started = performance.now();
    try {
      const res = await fetch(url, {
        method: endpoint.method,
        headers,
        body: withBody ? draft.body : undefined,
        // A pasted token speaks for someone else; don't send the admin's cookie alongside it.
        credentials: token.trim() ? "omit" : "include",
      });
      const text = await res.text();
      const ms = Math.round(performance.now() - started);
      let pretty = text;
      let isJson = false;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
        isJson = true;
      } catch {
        // Not JSON (a 204, an image, an HTML error page) — show it as-is.
      }
      setResponse({
        status: res.status,
        statusText: res.statusText,
        ms,
        size: new Blob([text]).size,
        headers: [...res.headers.entries()],
        body: pretty,
        isJson,
      });
      const entry: HistoryEntry = {
        at: new Date().toISOString(),
        endpointId: endpoint.id,
        url,
        status: res.status,
        ms,
        draft,
      };
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, MAX_HISTORY);
        writeHistory(next);
        return next;
      });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Network error");
      setResponse(null);
    } finally {
      setSending(false);
    }
  };
  sendRef.current = () => void send();

  const auth = AUTH_META[endpoint.auth];
  const AuthIcon = auth.icon;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API SDK"
        description={
          <>
            Every endpoint Graft exposes, runnable from here as you. {API_CATALOGUE.length}{" "}
            endpoints across {groups.length} services; requests from the Bruno collection are
            attached as examples.
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        {/* Catalogue */}
        <aside className="flex max-h-[calc(100vh-10rem)] flex-col gap-3 rounded-xl border border-border bg-card p-3 lg:sticky lg:top-20">
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger aria-label="Service" className="w-full bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All services</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="Filter endpoints"
              placeholder="Filter by path, method or text…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="bg-background pl-8"
            />
          </div>
          <ul className="-mx-1 flex-1 overflow-y-auto" aria-label="Endpoints">
            {visible.map((e, index) => {
              const showGroup = group === "all" && e.group !== visible[index - 1]?.group;
              return (
                <li key={e.id}>
                  {showGroup ? (
                    <p className="px-2 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase first:pt-0">
                      {e.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => select(e)}
                    aria-current={e.id === endpoint.id ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                      e.id === endpoint.id
                        ? "bg-graft-green/10 ring-1 ring-graft-green/30"
                        : "hover:bg-muted",
                    )}
                  >
                    <MethodBadge method={e.method} />
                    <span className="min-w-0 flex-1 truncate font-mono" title={e.path}>
                      {e.path.replace(/^\/api\/v1/, "")}
                    </span>
                    {e.examples.length > 0 ? (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={`${e.examples.length} Bruno examples`}
                      >
                        {e.examples.length}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {visible.length === 0 ? (
              <li className="px-2 py-4 text-sm text-muted-foreground">No endpoints match.</li>
            ) : null}
          </ul>
        </aside>

        {/* Request + response */}
        <div className="flex min-w-0 flex-col gap-4">
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <MethodBadge method={endpoint.method} className="text-xs" />
                <code className="min-w-0 font-mono text-sm font-semibold break-all">
                  {endpoint.path}
                </code>
                <Pill tone={auth.tone}>
                  <AuthIcon className="size-3" aria-hidden="true" />
                  {auth.label}
                </Pill>
              </div>
              {endpoint.summary ? (
                <p className="text-sm text-muted-foreground">{endpoint.summary}</p>
              ) : null}
              <p className="font-mono text-[11px] text-muted-foreground">{endpoint.source}</p>
            </div>

            {endpoint.examples.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <WandSparklesIcon className="size-3.5 text-graft-green" aria-hidden="true" />
                  Examples from the Bruno collection
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {endpoint.examples.map((example, index) => (
                    <button
                      key={example.file}
                      type="button"
                      onClick={() => loadExample(index)}
                      title={example.file}
                      className="max-w-full truncate rounded-md border border-border px-2 py-1 text-left text-xs hover:border-graft-green/50 hover:bg-graft-green/5"
                    >
                      {example.name || example.file}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {endpoint.params.length > 0 ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Path params
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {endpoint.params.map((param) => (
                    <label key={param} className="flex flex-col gap-1 text-xs">
                      <span className="font-mono">:{param}</span>
                      <Input
                        value={draft.pathParams[param] ?? ""}
                        onChange={(event) =>
                          setDraft((d) => ({
                            ...d,
                            pathParams: { ...d.pathParams, [param]: event.target.value },
                          }))
                        }
                        placeholder={
                          param.toLowerCase().endsWith("id") ? "24-character id" : param
                        }
                        className="bg-background font-mono"
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Query
              </legend>
              {draft.query.map((row, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    aria-label={`Query key ${index + 1}`}
                    placeholder="key"
                    value={row.key}
                    onChange={(event) =>
                      setDraft((d) => ({
                        ...d,
                        query: d.query.map((r, i) =>
                          i === index ? { ...r, key: event.target.value } : r,
                        ),
                      }))
                    }
                    className="bg-background font-mono sm:w-48"
                  />
                  <Input
                    aria-label={`Query value ${index + 1}`}
                    placeholder="value"
                    value={row.value}
                    onChange={(event) =>
                      setDraft((d) => ({
                        ...d,
                        query: d.query.map((r, i) =>
                          i === index ? { ...r, value: event.target.value } : r,
                        ),
                      }))
                    }
                    className="flex-1 bg-background font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove query parameter"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        query:
                          d.query.length > 1
                            ? d.query.filter((_, i) => i !== index)
                            : [{ key: "", value: "" }],
                      }))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() =>
                  setDraft((d) => ({ ...d, query: [...d.query, { key: "", value: "" }] }))
                }
              >
                <PlusIcon aria-hidden="true" />
                Add parameter
              </Button>
            </fieldset>

            {hasBody(endpoint.method) ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 flex w-full items-center justify-between text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  JSON body
                </legend>
                <textarea
                  aria-label="Request body"
                  value={draft.body}
                  onChange={(event) => setDraft((d) => ({ ...d, body: event.target.value }))}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      sendRef.current();
                    }
                  }}
                  spellCheck={false}
                  rows={Math.min(18, Math.max(5, draft.body.split("\n").length + 1))}
                  className={cn(
                    "w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    bodyError && "border-destructive",
                  )}
                />
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span
                    className={cn(bodyError ? "text-destructive" : "text-muted-foreground")}
                  >
                    {bodyError ? `Invalid JSON: ${bodyError}` : "Valid JSON"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={Boolean(bodyError) || !draft.body.trim()}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        body: JSON.stringify(JSON.parse(d.body), null, 2),
                      }))
                    }
                  >
                    Format
                  </Button>
                </div>
              </fieldset>
            ) : null}

            <details className="text-xs">
              <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-muted-foreground">
                <KeyRoundIcon className="size-3.5" aria-hidden="true" />
                Run as someone else (bearer token)
              </summary>
              <div className="mt-2 flex flex-col gap-1">
                <Input
                  aria-label="Bearer token"
                  type="password"
                  autoComplete="off"
                  placeholder="Paste an access token — leave empty to use your own session"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  className="bg-background font-mono"
                />
                <span className="text-muted-foreground">
                  Kept in this tab only. With a token set, your own session cookie is not sent.
                </span>
              </div>
            </details>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
              <code
                className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs"
                title={url}
              >
                {endpoint.method} {url}
              </code>
              <div className="flex items-center gap-2">
                <CopyButton
                  value={curlFor(endpoint.method, url, draft.body, token.trim())}
                  label="Copy as curl"
                />
                <Button
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSend}
                  loading={sending}
                >
                  {sending ? null : <SendIcon aria-hidden="true" />}
                  Send
                </Button>
              </div>
            </div>
            {endpoint.method !== "GET" ? (
              <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {endpoint.method} is a real write against this environment&apos;s data
                {endpoint.auth === "session"
                  ? ", in the workspace your session is signed in to"
                  : ""}
                .
              </p>
            ) : null}
            {missingParams.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Fill in {missingParams.map((p) => `:${p}`).join(", ")} to send.
              </p>
            ) : null}
            {unfilledVars ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                This request still contains Bruno {"{{variables}}"} — replace them with real
                values.
              </p>
            ) : null}
          </section>

          <section
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
            aria-live="polite"
          >
            <h2 className="text-sm font-semibold">Response</h2>
            {sending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> Waiting for{" "}
                {endpoint.path}…
              </p>
            ) : requestError ? (
              <p className="text-sm text-destructive">
                Request failed before a response: {requestError}
              </p>
            ) : response ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Pill
                    tone={
                      response.status < 300 ? "green" : response.status < 500 ? "amber" : "red"
                    }
                  >
                    {response.status} {response.statusText}
                  </Pill>
                  <span className="text-muted-foreground">{response.ms} ms</span>
                  <span className="text-muted-foreground">
                    {(response.size / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowHeaders((v) => !v)}
                    className="text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {showHeaders ? "Hide" : "Show"} headers ({response.headers.length})
                  </button>
                  <span className="ml-auto">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void navigator.clipboard?.writeText(response.body)}
                    >
                      <CopyIcon aria-hidden="true" />
                      Copy body
                    </Button>
                  </span>
                </div>
                {showHeaders ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-lg bg-muted/40 p-3 font-mono text-[11px]">
                    {response.headers.map(([name, value]) => (
                      <HeaderRow key={name} name={name} value={value} />
                    ))}
                  </dl>
                ) : null}
                {response.body ? (
                  response.isJson ? (
                    <JsonView text={response.body} />
                  ) : (
                    <pre className="max-h-[32rem] overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
                      {response.body}
                    </pre>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">Empty body.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Send a request to see its response here. Tip: Ctrl/⌘ + Enter in the body sends.
              </p>
            )}
          </section>

          {history.length > 0 ? (
            <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <HistoryIcon className="size-4" aria-hidden="true" /> History
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setHistory([]);
                    writeHistory([]);
                  }}
                >
                  Clear
                </Button>
              </div>
              <ul className="flex flex-col divide-y divide-border">
                {history.map((entry, index) => {
                  const e = API_CATALOGUE.find((c) => c.id === entry.endpointId);
                  if (!e) return null;
                  return (
                    <li key={`${entry.at}-${index}`}>
                      <button
                        type="button"
                        onClick={() => select(e, entry.draft)}
                        className="flex w-full items-center gap-2 py-1.5 text-left text-xs hover:text-graft-green-deep dark:hover:text-graft-green-light"
                      >
                        <MethodBadge method={e.method} />
                        <span className="min-w-0 flex-1 truncate font-mono">{entry.url}</span>
                        <Pill
                          tone={
                            entry.status < 300 ? "green" : entry.status < 500 ? "amber" : "red"
                          }
                        >
                          {entry.status}
                        </Pill>
                        <span className="w-14 text-right text-muted-foreground">
                          {entry.ms} ms
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HeaderRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="break-all">{value}</dd>
    </>
  );
}
