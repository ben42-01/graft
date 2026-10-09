/**
 * Turns the API catalogue (src/lib/admin/api-catalogue.json, generated from the
 * routes and the Bruno suite by `npm run api:catalogue`) into CLI commands.
 *
 * Commands are derived, not hand-written, so a new endpoint is a new command
 * the moment the catalogue is regenerated, and the CLI cannot drift from the
 * API. The rule, by example:
 *
 *   GET    /orders                         graft orders list
 *   POST   /orders                         graft orders create
 *   GET    /orders/:orderId                graft orders get <orderId>
 *   PATCH  /orders/:orderId                graft orders update <orderId>
 *   GET    /entities/:entityId/records     graft entities records list <entityId>
 *   POST   /forms/:formId/publish          graft forms publish <formId>        (an action)
 *   PUT    /orders/:orderId/payment-link   graft orders payment-link-set <orderId>
 *   GET    /reports/sales                  graft reports sales get
 *
 * Nouns are the static path segments; path parameters become positional
 * arguments in order. A trailing segment with no GET of its own and nothing
 * addressable below it is an *action* on what precedes it, not a resource.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type CatalogueExample = {
  name: string;
  file: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  body: string | null;
};

export type CatalogueEndpoint = {
  id: string;
  method: string;
  path: string;
  group: string;
  params: string[];
  auth: "platform-admin" | "session" | "public";
  summary: string;
  source: string;
  examples: CatalogueExample[];
};

export type Command = {
  noun: string[];
  verb: string;
  method: string;
  path: string;
  params: string[];
  summary: string;
  examples: CatalogueExample[];
};

/** Groups the CLI covers with its own commands, or that are not for customers. */
const EXCLUDED_GROUPS = new Set(["system", "auth", "webhooks", "public"]);
const API_PREFIX = "/api/v1/";

/** The catalogue a customer's CLI should know: no platform-admin endpoints. */
export function customerEndpoints(endpoints: CatalogueEndpoint[]): CatalogueEndpoint[] {
  return endpoints.filter(
    (e) =>
      e.auth !== "platform-admin" &&
      !EXCLUDED_GROUPS.has(e.group) &&
      e.path.startsWith(API_PREFIX),
  );
}

export function loadCatalogue(): CatalogueEndpoint[] {
  // Built CLI: dist/catalogue.json, written by scripts/build.mjs.
  // From the repo (tsx cli/src/main.ts): the app's own catalogue.
  const candidates = [
    new URL("./catalogue.json", import.meta.url),
    new URL("../../src/lib/admin/api-catalogue.json", import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        endpoints: CatalogueEndpoint[];
      };
      return customerEndpoints(parsed.endpoints);
    }
  }
  throw new Error("API catalogue not found — reinstall the CLI");
}

const isParam = (segment: string) => segment.startsWith(":");

const ITEM_VERB: Record<string, string> = {
  GET: "get",
  PATCH: "update",
  PUT: "set",
  DELETE: "delete",
  POST: "confirm",
};
const COLLECTION_VERB: Record<string, string> = {
  GET: "list",
  POST: "create",
  PATCH: "update",
  PUT: "set",
  DELETE: "delete",
};

export function deriveCommands(endpoints: CatalogueEndpoint[]): Command[] {
  const paths = new Set(endpoints.map((e) => e.path));
  const hasGet = new Set(endpoints.filter((e) => e.method === "GET").map((e) => e.path));
  /** Some route lives below this path with a parameter right after it. */
  const hasItems = (path: string) => [...paths].some((p) => p.startsWith(`${path}/:`));

  const commands = endpoints.map((e): Command => {
    const segments = e.path.slice(API_PREFIX.length).split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    const statics = segments.filter((s) => !isParam(s));
    const base = {
      method: e.method,
      path: e.path,
      params: e.params,
      summary: e.summary,
      examples: e.examples,
    };

    if (isParam(last)) {
      return { ...base, noun: statics, verb: ITEM_VERB[e.method] ?? e.method.toLowerCase() };
    }

    // Nothing to read here and nothing addressable below: a verb, not a noun.
    const isAction =
      segments.length > 1 && e.method !== "GET" && !hasGet.has(e.path) && !hasItems(e.path);
    if (isAction) {
      const verb =
        e.method === "POST"
          ? last
          : `${last}-${COLLECTION_VERB[e.method] ?? e.method.toLowerCase()}`;
      return { ...base, noun: statics.slice(0, -1), verb };
    }

    // A GET on a static path with nothing addressable under it is one thing
    // (the summary report, the setup state), not a list of things.
    const verb =
      e.method === "GET" && !hasItems(e.path) && !isCollectionName(last)
        ? "get"
        : COLLECTION_VERB[e.method];
    return { ...base, noun: statics, verb: verb ?? e.method.toLowerCase() };
  });

  // Two endpoints must never claim the same words; if a future route makes
  // them collide, the method disambiguates rather than one silently winning.
  const seen = new Map<string, number>();
  for (const c of commands) seen.set(key(c), (seen.get(key(c)) ?? 0) + 1);
  for (const c of commands)
    if ((seen.get(key(c)) ?? 0) > 1) c.verb = `${c.verb}-${c.method.toLowerCase()}`;

  return commands.sort((a, b) => key(a).localeCompare(key(b)));
}

/** Plural-looking names read as lists even without item routes (submissions, customers). */
function isCollectionName(segment: string): boolean {
  return /s$/.test(segment) && !/(sales|usage|summary|settings|status)$/.test(segment);
}

const key = (c: Command) => [...c.noun, c.verb].join(" ");
export const commandName = key;

/**
 * The command for these words, and the arguments left over. Longest noun
 * first, so `entities records list` wins over `entities`.
 */
export function matchCommand(
  commands: Command[],
  words: string[],
): { command: Command; rest: string[] } | null {
  let best: { command: Command; rest: string[] } | null = null;
  for (const command of commands) {
    const name = [...command.noun, command.verb];
    if (name.length > words.length) continue;
    if (
      name.every((w, i) => words[i] === w) &&
      (!best || name.length > best.command.noun.length + 1)
    ) {
      best = { command, rest: words.slice(name.length) };
    }
  }
  return best;
}

/** Commands whose name starts with these words — for "did you mean" and help. */
export function commandsUnder(commands: Command[], words: string[]): Command[] {
  return commands.filter((c) => words.every((w, i) => [...c.noun, c.verb][i] === w));
}

/** `/api/v1/orders/:orderId` + ["abc"] → `/api/v1/orders/abc`. */
export function fillPath(path: string, values: string[]): string {
  let i = 0;
  return path
    .split("/")
    .map((s) => (isParam(s) ? encodeURIComponent(values[i++] ?? "") : s))
    .join("/");
}
