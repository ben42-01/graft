/**
 * Builds the endpoint catalogue behind the admin console's SDK screen
 * (`/admin/sdk`) — `npm run api:catalogue`.
 *
 * Two sources, both already in the repo, so the catalogue cannot invent an
 * endpoint:
 *
 *  - **Routes.** Every `src/app/api/**\/route.ts`: the path comes from the
 *    folder (`[id]` → `:id`), the methods from its `export const GET = …`
 *    lines, the summary from the first paragraph of its header comment, and the
 *    auth level from what the handler calls (`assertPlatformAdmin`, `context()`).
 *  - **Examples.** Every `bruno/**\/*.bru` request, matched onto the route it
 *    hits. Its `body:json` block and query string become a runnable example;
 *    `{{vars}}` are kept as-is for the operator to fill.
 *
 * The output is committed (src/lib/admin/api-catalogue.json) so the page needs
 * no filesystem access at runtime. scripts/generate-api-catalogue.test.ts
 * rebuilds it and fails when the committed copy has drifted from the routes.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type CatalogueAuth = "platform-admin" | "session" | "public";

export type CatalogueExample = {
  name: string;
  file: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  body: string | null;
};

export type CatalogueEndpoint = {
  id: string;
  method: HttpMethod;
  path: string;
  group: string;
  params: string[];
  auth: CatalogueAuth;
  summary: string;
  source: string;
  examples: CatalogueExample[];
};

export type Catalogue = { endpoints: CatalogueEndpoint[] };

const MAX_SUMMARY = 280;

function walk(dir: string, match: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(entry)) out.push(full);
  }
  return out.sort();
}

/** `src/app/api/v1/entities/[id]/route.ts` → `/api/v1/entities/:id`. */
export function routePath(apiRoot: string, file: string): string {
  const segments = relative(apiRoot, file).split(sep).slice(0, -1);
  return (
    "/api/" +
    segments
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ":$1*").replace(/^\[(.+)\]$/, ":$1"))
      .join("/")
  );
}

export function exportedMethods(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((m) =>
    new RegExp(
      `export\\s+(const\\s+${m}\\b|async\\s+function\\s+${m}\\b|function\\s+${m}\\b)`,
    ).test(source),
  );
}

/** First paragraph of the leading `/** … *\/` block, minus a `GET /path —` prefix. */
export function summaryOf(source: string): string {
  const block = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
  const lines = block.split("\n").map((line) => line.replace(/^\s*\*\s?/, ""));
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  let text = paragraph.join(" ").replace(/\s+/g, " ").trim();
  // "GET /api/v1/x — does y" → "does y"; "GET|POST .../x (note)" → "(note)".
  const verbs = "(GET|POST|PUT|PATCH|DELETE)(\\s*[,/|]\\s*(GET|POST|PUT|PATCH|DELETE))*";
  text = text
    .replace(new RegExp(`^(${verbs}\\s+)?\\S*/\\S+\\s+[—–-]\\s+`), "")
    .replace(new RegExp(`^${verbs}\\s+\\S*/\\S+\\s*`), "")
    // The protected-path notice is for agents editing the file, not API users.
    .replace(/\s*PROTECTED PATH\b.*$/, "")
    .trim();
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : text;
}

export function authOf(source: string): CatalogueAuth {
  // Calls, not mentions — route headers discuss `context()` in prose.
  if (/await\s+assertPlatformAdmin\(/.test(source)) return "platform-admin";
  if (/await\s+context\(\)/.test(source)) return "session";
  return "public";
}

/** `/api/v1/entities/...` → "entities"; anything outside `/api/v1` is "system". */
const groupOf = (path: string): string => {
  const parts = path.split("/").filter(Boolean); // ["api", "v1", "entities", ...]
  return parts[1] === "v1" ? (parts[2] ?? "system") : "system";
};

/**
 * The `/api/v1/[...path]` fallback answers unrouted paths with the error
 * envelope. It is not an endpoint anyone calls on purpose, and as a wildcard it
 * would swallow every Bruno example that matched nothing more specific.
 */
const isCatchAll = (path: string): boolean => /\/:[^/]+\*$/.test(path);

// ---- Bruno --------------------------------------------------------------

export type BrunoRequest = {
  name: string;
  method: HttpMethod;
  path: string;
  query: Record<string, string>;
  body: string | null;
};

/** The text inside a top-level `name {` … `}` block (closing brace at column 0). */
function block(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^${name.replace(/[:]/g, "\\:")} \\{$`, "m"));
  if (start === -1) return null;
  const open = source.indexOf("\n", start) + 1;
  const close = source.indexOf("\n}", open - 1);
  return close === -1 ? null : source.slice(open, close);
}

const dedent = (text: string): string => {
  const lines = text.split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return lines
    .map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    .join("\n")
    .trim();
};

export function parseBruno(source: string): BrunoRequest | null {
  const name = /^\s*name:\s*(.+)$/m.exec(block(source, "meta") ?? "")?.[1]?.trim() ?? "";
  for (const method of HTTP_METHODS) {
    const body = block(source, method.toLowerCase());
    if (body === null) continue;
    const url = /^\s*url:\s*(.+)$/m.exec(body)?.[1]?.trim();
    if (!url) return null;
    const withoutBase = url.replace(/^\{\{baseUrl\}\}/, "");
    const [pathPart = "", queryPart = ""] = withoutBase.split("?");
    const query: Record<string, string> = {};
    for (const pair of queryPart.split("&").filter(Boolean)) {
      const [k = "", v = ""] = pair.split("=");
      query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    const json = block(source, "body:json");
    return { name, method, path: pathPart, query, body: json ? dedent(json) : null };
  }
  return null;
}

/** Path params a concrete path fills in a pattern, or null when it does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.endsWith("*") && seg.startsWith(":")) {
      if (i >= s.length) return null;
      params[seg.slice(1, -1)] = s.slice(i).join("/");
      return params;
    }
    if (i >= s.length) return null;
    if (seg.startsWith(":")) params[seg.slice(1)] = s[i]!;
    else if (seg !== s[i]) return null;
  }
  return p.length === s.length ? params : null;
}

const literalCount = (pattern: string) =>
  pattern.split("/").filter((s) => s && !s.startsWith(":")).length;

// ---- Build --------------------------------------------------------------

export function buildCatalogue(root: string): Catalogue {
  const apiRoot = join(root, "src/app/api");
  const endpoints: CatalogueEndpoint[] = [];

  for (const file of walk(apiRoot, (f) => f === "route.ts")) {
    const source = readFileSync(file, "utf8");
    const path = routePath(apiRoot, file);
    if (isCatchAll(path)) continue;
    for (const method of exportedMethods(source)) {
      endpoints.push({
        id: `${method} ${path}`,
        method,
        path,
        group: groupOf(path),
        params: path
          .split("/")
          .filter((s) => s.startsWith(":"))
          .map((s) => s.slice(1).replace(/\*$/, "")),
        auth: authOf(source),
        summary: summaryOf(source),
        source: relative(root, file).split(sep).join("/"),
        examples: [],
      });
    }
  }

  // Most specific pattern first, so `/entities/:id/records` beats `/:a/:b/:c`.
  const byMethod = (method: HttpMethod) =>
    endpoints
      .filter((e) => e.method === method)
      .sort((a, b) => literalCount(b.path) - literalCount(a.path));

  for (const file of walk(join(root, "bruno"), (f) => f.endsWith(".bru"))) {
    const request = parseBruno(readFileSync(file, "utf8"));
    if (!request) continue;
    for (const endpoint of byMethod(request.method)) {
      const pathParams = matchPath(endpoint.path, request.path);
      if (!pathParams) continue;
      endpoint.examples.push({
        name: request.name,
        file: relative(root, file).split(sep).join("/"),
        pathParams,
        query: request.query,
        body: request.body,
      });
      break;
    }
  }

  endpoints.sort((a, b) =>
    a.path === b.path
      ? HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method)
      : a.path.localeCompare(b.path),
  );
  return { endpoints };
}

export const CATALOGUE_FILE = "src/lib/admin/api-catalogue.json";

export const serialise = (catalogue: Catalogue): string =>
  `${JSON.stringify(catalogue, null, 2)}\n`;

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  const root = process.cwd();
  const catalogue = buildCatalogue(root);
  writeFileSync(join(root, CATALOGUE_FILE), serialise(catalogue));
  const examples = catalogue.endpoints.reduce((n, e) => n + e.examples.length, 0);
  console.log(
    `[graft] wrote ${CATALOGUE_FILE}: ${catalogue.endpoints.length} endpoints, ${examples} Bruno examples`,
  );
}
