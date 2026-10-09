#!/usr/bin/env node
/**
 * graft — Graft from the terminal. See cli/README.md.
 *
 *   graft login --url https://graft.example     sign in with your browser
 *   graft whoami
 *   graft entities list
 *   graft entities records list <entityId> --all --json
 *   graft orders get <orderId>
 *   graft api GET /api/v1/reports/summary        anything the API offers
 *   graft commands                               every generated command
 *
 * Exit codes: 0 ok · 1 request refused · 2 usage · 3 not signed in ·
 * 4 forbidden · 5 not found · 6 server error.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  commandName,
  commandsUnder,
  deriveCommands,
  fillPath,
  loadCatalogue,
  matchCommand,
  type Command,
} from "./catalogue.js";
import {
  ApiError,
  AuthRequired,
  GraftClient,
  ReadOnlyRefused,
  readOnly,
  refreshFromSetCookie,
  type Envelope,
} from "./client.js";
import { profileName, readConfig, updateProfile, configDir } from "./config.js";
import { login, revoke } from "./login.js";
import { bold, dim, green, red, render, stdio, table, type Writer } from "./output.js";

export class UsageError extends Error {}

const VERSION = (() => {
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    return "0.0.0";
  }
})();

const OPTIONS = {
  profile: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  url: { type: "string" },
  "no-browser": { type: "boolean" },
  data: { type: "string", short: "d" },
  set: { type: "string", multiple: true },
  query: { type: "string", short: "q", multiple: true },
  all: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
} as const;

type Flags = {
  profile?: string;
  json?: boolean;
  help?: boolean;
  version?: boolean;
  url?: string;
  "no-browser"?: boolean;
  data?: string;
  set?: string[];
  query?: string[];
  all?: boolean;
  yes?: boolean;
};

export type Io = { w: Writer; stdin: () => Promise<string>; isTTY: boolean };

const defaultIo = (): Io => ({
  w: stdio(),
  isTTY: Boolean(process.stdin.isTTY),
  stdin: async () => {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
  },
});

// ── Request building ──────────────────────────────────────────────────────────

/** "a.b=1" → { a: { b: 1 } }. Values are JSON when they parse as JSON, else strings. */
export function applySet(
  target: Record<string, unknown>,
  assignment: string,
): Record<string, unknown> {
  const eq = assignment.indexOf("=");
  if (eq < 1) throw new UsageError(`--set expects key=value, got '${assignment}'`);
  const path = assignment.slice(0, eq).split(".");
  const raw = assignment.slice(eq + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* a plain string */
  }
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
  return target;
}

export async function buildBody(flags: Flags, io: Io): Promise<unknown> {
  let body: unknown;
  if (flags.data !== undefined) {
    const source =
      flags.data === "-"
        ? await io.stdin()
        : flags.data.startsWith("@")
          ? readFileSync(flags.data.slice(1), "utf8")
          : flags.data;
    try {
      body = JSON.parse(source);
    } catch {
      throw new UsageError("--data must be JSON (inline, @file.json, or - for stdin)");
    }
  }
  for (const assignment of flags.set ?? []) {
    if (
      body !== undefined &&
      (typeof body !== "object" || body === null || Array.isArray(body))
    ) {
      throw new UsageError("--set can only add fields to a JSON object body");
    }
    body = applySet((body as Record<string, unknown>) ?? {}, assignment);
  }
  return body;
}

export function buildQuery(flags: Flags): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const pair of flags.query ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new UsageError(`--query expects key=value, got '${pair}'`);
    (query[pair.slice(0, eq)] ??= []).push(pair.slice(eq + 1));
  }
  return query;
}

/** Follows `meta.cursor` while `meta.hasMore`, concatenating the pages. */
export async function requestAll(
  client: GraftClient,
  path: string,
  query: Record<string, string[]>,
): Promise<Envelope> {
  let first: Envelope | null = null;
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const env: Envelope = await client.request("GET", path, {
      query: cursor ? { ...query, cursor: [cursor] } : query,
    });
    first ??= env;
    if (!Array.isArray(env.data)) return env; // not a list — nothing to page
    items.push(...env.data);
    cursor = env.meta.hasMore && typeof env.meta.cursor === "string" ? env.meta.cursor : null;
    if (!cursor) break;
  }
  return { ...first!, data: items, meta: { ...first!.meta, hasMore: false, cursor: null } };
}

async function confirm(io: Io, flags: Flags, question: string): Promise<void> {
  if (flags.yes) return;
  if (!io.isTTY)
    throw new UsageError(`${question} — refusing without a terminal; pass --yes to confirm`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new UsageError("aborted");
}

// ── Built-in commands ─────────────────────────────────────────────────────────

type Me = {
  user: { id: string; email: string; name: string | null };
  memberships: { tenantId: string; slug: string; name: string; roles: string[] }[];
  tenant: { id: string; name: string; slug: string; tier: string };
};

async function whoami(client: GraftClient, flags: Flags, io: Io) {
  const me = (await client.request("GET", "/api/v1/me")).data as Me;
  if (flags.json) return io.w.out(JSON.stringify(me, null, 2));
  const roles = me.memberships.find((m) => m.tenantId === me.tenant.id)?.roles.join(", ") ?? "";
  io.w.out(
    [
      `${dim(io.w, "user      ")}${me.user.email}${me.user.name ? dim(io.w, ` (${me.user.name})`) : ""}`,
      `${dim(io.w, "workspace ")}${me.tenant.name} ${dim(io.w, `· ${me.tenant.slug} · ${me.tenant.tier} · ${roles}`)}`,
      `${dim(io.w, "server    ")}${client.baseUrl}`,
      `${dim(io.w, "profile   ")}${client.profileName}`,
    ].join("\n"),
  );
}

async function workspace(client: GraftClient, args: string[], flags: Flags, io: Io) {
  const [sub, target] = args;
  const me = (await client.request("GET", "/api/v1/me")).data as Me;
  if (!sub || sub === "list") {
    const rows = me.memberships.map((m) => ({
      current: m.tenantId === me.tenant.id ? "▶" : "",
      name: m.name,
      slug: m.slug,
      id: m.tenantId,
      roles: m.roles,
    }));
    return io.w.out(flags.json ? JSON.stringify(rows, null, 2) : table(rows, io.w));
  }
  if (sub !== "use" || !target)
    throw new UsageError("usage: graft workspace list | graft workspace use <slug|id|name>");
  const wanted = target.toLowerCase();
  const membership = me.memberships.find(
    (m) =>
      m.tenantId === target ||
      m.slug.toLowerCase() === wanted ||
      m.name.toLowerCase() === wanted,
  );
  if (!membership)
    throw new UsageError(
      `You are not a member of a workspace called '${target}' — see \`graft workspace list\``,
    );
  if (membership.tenantId === me.tenant.id) return io.w.err(`Already in ${membership.name}.`);

  const old = client.profile()?.session;
  const env = await client.request("POST", "/api/v1/auth/switch-tenant", {
    body: { tenantId: membership.tenantId },
  });
  const data = env.data as { accessToken: string; expiresAt: string };
  const refreshToken = refreshFromSetCookie(env.headers);
  if (!refreshToken)
    throw new Error("The server switched workspace but sent no refresh token.");
  await updateProfile(client.profileName, (p) => ({
    ...p!,
    session: {
      accessToken: data.accessToken,
      accessExpiresAt: data.expiresAt,
      refreshToken,
      email: me.user.email,
      tenantId: membership.tenantId,
      tenantName: membership.name,
    },
  }));
  // The previous workspace's session stays valid server-side unless ended.
  if (old) await revoke(client, old);
  io.w.err(`${green(io.w, "✓")} Now in ${bold(io.w, membership.name)}`);
}

async function logout(client: GraftClient, io: Io) {
  const session = client.profile()?.session;
  if (!session) return io.w.err("Not signed in.");
  const ended = await revoke(client, session);
  await updateProfile(client.profileName, (p) => (p ? { ...p, session: undefined } : p));
  io.w.err(
    ended
      ? `${green(io.w, "✓")} Signed out`
      : "Signed out locally (the server session had already ended).",
  );
}

function profiles(io: Io, flags: Flags) {
  const config = readConfig();
  const rows = Object.entries(config.profiles).map(([name, p]) => ({
    name,
    url: p.baseUrl,
    email: p.session?.email ?? "—",
    workspace: p.session?.tenantName ?? "—",
  }));
  io.w.out(flags.json ? JSON.stringify(rows, null, 2) : table(rows, io.w));
  if (!flags.json) io.w.err(dim(io.w, `\nconfig: ${configDir()}`));
}

function usage(commands: Command[], w: Writer): string {
  const nouns = [...new Set(commands.map((c) => c.noun[0]))].sort();
  return [
    `${bold(w, "graft")} ${VERSION} — Graft from the terminal`,
    "",
    bold(w, "Account"),
    "  login [--url URL] [--no-browser]   Sign in with your browser",
    "  logout                             End this session",
    "  whoami                             Who and where you are",
    "  workspace list | use <slug>        Your workspaces; switch between them",
    "  profiles                           Saved Graft servers (--profile NAME to pick)",
    "",
    bold(w, "Your data") + dim(w, "  (graft <area> --help for its commands)"),
    ...wrap(nouns.join("  "), 76).map((l) => `  ${l}`),
    "",
    bold(w, "Anything else"),
    "  api <METHOD> <path>                Call any endpoint, e.g. graft api GET /api/v1/reports/summary",
    "  commands [words]                   Every command, with its endpoint",
    "  describe <command…>                What a command does, its arguments and examples",
    "",
    bold(w, "Flags"),
    "  -d, --data JSON|@file|-            Request body          --set key=value   Body field (repeatable)",
    "  -q, --query key=value              Query parameter       --all             Fetch every page",
    "  --json                             Raw data, for scripts --profile NAME    Which server",
    "  -y, --yes                          Skip delete confirmations",
  ].join("\n");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = "";
    }
    line += " " + word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function describe(command: Command, w: Writer): string {
  const args = command.params.map((p) => `<${p}>`).join(" ");
  const lines = [
    `${bold(w, `graft ${commandName(command)}`)} ${args}`,
    `${dim(w, `${command.method} ${command.path}`)}`,
  ];
  if (command.summary) lines.push("", command.summary);
  const examples = command.examples.filter((e) => e.body || Object.keys(e.query).length);
  if (examples.length) {
    lines.push(
      "",
      bold(w, "Examples") + dim(w, " (from the API test suite; {{…}} are placeholders)"),
    );
    for (const e of examples.slice(0, 3)) {
      lines.push(dim(w, `  # ${e.name}`));
      const q = Object.entries(e.query)
        .map(([k, v]) => ` -q ${k}=${v}`)
        .join("");
      const d = e.body ? ` -d '${e.body.replace(/\s*\n\s*/g, " ")}'` : "";
      lines.push("  " + `graft ${commandName(command)} ${args}${q}${d}`.replace(/ +/g, " "));
    }
  }
  return lines.join("\n");
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function run(
  argv: string[],
  io: Io = defaultIo(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.w.err(red(io.w, `error: ${(error as Error).message}`));
    return 2;
  }
  const flags = parsed.values as Flags;
  const words = parsed.positionals;
  const commands = deriveCommands(loadCatalogue());
  const client = new GraftClient(profileName(flags.profile, env), { env });

  try {
    if (flags.version) return (io.w.out(VERSION), 0);
    const [first, ...rest] = words;
    switch (first) {
      case undefined:
      case "help":
        if (rest.length) return run([...rest, "--help"], io, env);
        io.w.out(usage(commands, io.w));
        return 0;
      case "login":
      case "logout":
        if (readOnly(env)) throw new ReadOnlyRefused(`graft ${first}`);
    }
    switch (first) {
      case "login": {
        const baseUrl = flags.url ?? env.GRAFT_URL ?? client.profile()?.baseUrl;
        if (!baseUrl)
          throw new UsageError(
            "Which Graft? Run `graft login --url https://your-graft-host` the first time.",
          );
        if (!/^https?:\/\//.test(baseUrl))
          throw new UsageError("--url must start with https:// (or http:// for local)");
        await login(
          client,
          baseUrl.replace(/\/+$/, ""),
          { browser: !flags["no-browser"], version: VERSION },
          io.w,
        );
        return 0;
      }
      case "logout":
        await logout(client, io);
        return 0;
      case "whoami":
        await whoami(client, flags, io);
        return 0;
      case "workspace":
      case "workspaces":
        await workspace(client, rest, flags, io);
        return 0;
      case "profiles":
        profiles(io, flags);
        return 0;
      case "commands": {
        const list = commandsUnder(commands, rest);
        if (flags.json) {
          io.w.out(
            JSON.stringify(
              list.map((c) => ({
                command: commandName(c),
                args: c.params,
                method: c.method,
                path: c.path,
                summary: c.summary,
              })),
              null,
              2,
            ),
          );
        } else {
          io.w.out(
            table(
              list.map((c) => ({
                command: commandName(c),
                args: c.params.map((p) => `<${p}>`).join(" "),
                endpoint: `${c.method} ${c.path}`,
              })),
              io.w,
            ),
          );
        }
        return 0;
      }
      case "describe": {
        const match = matchCommand(commands, rest);
        if (!match)
          throw new UsageError(`No command '${rest.join(" ")}' — see \`graft commands\``);
        io.w.out(describe(match.command, io.w));
        return 0;
      }
      case "api": {
        const [method, path] = rest;
        if (!method || !path)
          throw new UsageError("usage: graft api <METHOD> <path> [-d JSON] [-q key=value]");
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/i.test(method))
          throw new UsageError(`unknown method '${method}'`);
        if (/^delete$/i.test(method)) await confirm(io, flags, `DELETE ${path}?`);
        const query = buildQuery(flags);
        const env2 =
          flags.all && /^get$/i.test(method)
            ? await requestAll(client, path, query)
            : await client.request(method, path, { query, body: await buildBody(flags, io) });
        io.w.out(render(env2.data, io.w, Boolean(flags.json)));
        return 0;
      }
    }

    const match = matchCommand(commands, words);
    if (!match || flags.help) {
      const under = commandsUnder(commands, words);
      if (match && flags.help) return (io.w.out(describe(match.command, io.w)), 0);
      if (under.length) {
        io.w.out(
          table(
            under.map((c) => ({
              command: commandName(c),
              args: c.params.map((p) => `<${p}>`).join(" "),
            })),
            io.w,
          ),
        );
        return flags.help ? 0 : 2;
      }
      throw new UsageError(`Unknown command '${words.join(" ")}' — see \`graft help\``);
    }

    const { command, rest: args } = match;
    if (args.length !== command.params.length) {
      throw new UsageError(
        `usage: graft ${commandName(command)} ${command.params.map((p) => `<${p}>`).join(" ")}`.trim(),
      );
    }
    const path = fillPath(command.path, args);
    if (command.method === "DELETE")
      await confirm(io, flags, `${commandName(command)} ${args.join(" ")}`.trim() + "?");
    const query = buildQuery(flags);
    const result =
      flags.all && command.method === "GET"
        ? await requestAll(client, path, query)
        : await client.request(command.method, path, {
            query,
            body: await buildBody(flags, io),
          });
    io.w.out(render(result.data, io.w, Boolean(flags.json)));
    if (!flags.json && result.meta.hasMore)
      io.w.err(dim(io.w, "more results — add --all to fetch every page"));
    return 0;
  } catch (error) {
    return report(error, io.w);
  }
}

export function report(error: unknown, w: Writer): number {
  if (error instanceof UsageError) {
    w.err(red(w, `error: ${error.message}`));
    return 2;
  }
  if (error instanceof ReadOnlyRefused) {
    w.err(red(w, error.message));
    return 4;
  }
  if (error instanceof AuthRequired) {
    w.err(red(w, error.message));
    return 3;
  }
  if (error instanceof ApiError) {
    w.err(red(w, `error ${error.code}: ${error.message}`));
    const fields = (error.details as { fields?: Record<string, string> } | undefined)?.fields;
    for (const [field, reason] of Object.entries(fields ?? {})) w.err(`  ${field}: ${reason}`);
    if (error.requestId)
      w.err(dim(w, `request id: ${error.requestId} (quote this to support)`));
    if (error.status === 401) return 3;
    if (error.status === 403) return 4;
    if (error.status === 404) return 5;
    return error.status >= 500 ? 6 : 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  w.err(red(w, `error: ${message}`));
  return /fetch failed|ECONNREFUSED|ENOTFOUND/.test(message) ? 6 : 1;
}

// Run when executed (the `graft` bin, or tsx cli/src/main.ts), not when imported by a test.
const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : "";
if (
  invoked.endsWith("/main.js") ||
  invoked.endsWith("/main.ts") ||
  invoked.endsWith("/graft")
) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
