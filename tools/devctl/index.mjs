#!/usr/bin/env node
// devctl — a tiny process manager for the local dev stack. See README.md.
import readline from "node:readline";
import { items, presets, find } from "./services.mjs";
import { Supervisor } from "./supervisor.mjs";

const out = process.stdout;
const tty = Boolean(process.stdin.isTTY && out.isTTY);
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = (s) => c(2, s);
const bold = (s) => c(1, s);
const PALETTE = [36, 35, 33, 32, 34, 91, 96, 95];
const color = Object.fromEntries(items.map((i, n) => [i.name, PALETTE[n % PALETTE.length]]));
const width = Math.max(...items.map((i) => i.name.length));
const tag = (name) => c(color[name], name.padEnd(width)) + dim(" │ ");

const sup = new Supervisor();
const muted = new Set();
let rl = null;

// Print above the prompt without clobbering what the user is typing.
function print(text) {
  if (rl) {
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
  }
  out.write(text + "\n");
  rl?.prompt(true);
}
const info = (msg) => print(`${dim("devctl")} ${dim("│")} ${msg}`);

sup.on("line", (name, line) => !muted.has(name) && print(`${tag(name)}${line}`));
sup.on("exit", (name, code, signal, status) => {
  const what =
    status === "stopped"
      ? "stopped"
      : code === 0
        ? "finished"
        : `FAILED (${signal ?? `exit ${code}`})`;
  info(`${c(color[name], name)} ${status === "failed" ? c(31, what) : what}`);
});

const STATUS_COLOR = { running: 32, done: 32, failed: 31, exited: 33, stopped: 33, idle: 2 };
function showStatus() {
  const rows = items.map((i) => {
    const s = sup.status(i.name);
    const up = sup.isRunning(i.name)
      ? ` ${dim(Math.round((Date.now() - sup.procs.get(i.name).startedAt) / 1000) + "s")}`
      : "";
    const mute = muted.has(i.name) ? dim(" (muted)") : "";
    const label = c(color[i.name], i.name.padEnd(width));
    return `  ${label}  ${c(STATUS_COLOR[s], s.padEnd(8))} ${dim(i.kind.padEnd(7))} ${i.desc}${up}${mute}`;
  });
  print(rows.join("\n"));
}

function resolveNames(args) {
  const names = [];
  for (const a of args) {
    if (presets[a]) names.push(...presets[a]);
    else if (find(a)) names.push(a);
    else
      throw new Error(
        `unknown "${a}" — try: ${[...items.map((i) => i.name), ...Object.keys(presets)].join(", ")}`,
      );
  }
  return [...new Set(names)];
}

// Tasks first (in order, one at a time — `nuke` must finish before `app`), then services together.
async function startMany(names) {
  const list = names.map(find);
  for (const t of list.filter((i) => i.kind === "task")) {
    info(`running ${bold(t.name)} ${dim(`(${t.cmd})`)}`);
    if (!(await sup.start(t.name, { force: true })))
      return info(c(31, `${t.name} failed — aborting`));
  }
  await Promise.all(
    list
      .filter((i) => i.kind === "service")
      .map(async (s) => {
        if (sup.isRunning(s.name)) return info(`${s.name} already running`);
        info(`starting ${bold(s.name)} ${dim(`(${s.cmd})`)}`);
        if (!(await sup.start(s.name))) info(c(31, `${s.name} did not start`));
      }),
  );
}

const names = (args) => (args[0] === "all" ? items.map((i) => i.name) : resolveNames(args));
const running = () => items.filter((i) => sup.isRunning(i.name)).map((i) => i.name);

const HELP = `
  ${bold("start")} <name…>     start services/tasks (deps run first)   ${dim("alias: run, up")}
  ${bold("stop")} <name…|all>  stop (SIGTERM → SIGKILL after 5s)
  ${bold("restart")} <name…>   stop + start
  ${bold("status")}            what's running             ${dim("alias: ls")}
  ${bold("mute")} / ${bold("unmute")} <name>   hide/show a service's log lines
  ${bold("clear")}             clear screen
  ${bold("quit")}              stop everything and exit   ${dim("(or Ctrl-C)")}

  presets: ${Object.entries(presets)
    .map(([k, v]) => `${bold(k)} = ${v.join(" + ")}`)
    .join(", ")}
  names:   ${items.map((i) => i.name).join(", ")}
`;

async function exec(line) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case "":
      case undefined:
        return;
      case "start":
      case "run":
      case "up":
        return startMany(names(cmd === "up" && !args.length ? ["up"] : args));
      case "fresh":
        return startMany(names(["fresh"]));
      case "stop":
        if (!args.length) return info("stop what? give names or `all`");
        for (const n of args[0] === "all" ? running() : resolveNames(args)) {
          if (!(await sup.stop(n))) info(`${n} is not running`);
        }
        return;
      case "restart":
        if (!args.length) return info("restart what? give names or `all`");
        return Promise.all(
          (args[0] === "all" ? running() : resolveNames(args)).map(async (n) => {
            info(`restarting ${bold(n)}`);
            if (!(await sup.restart(n))) info(c(31, `${n} did not restart`));
          }),
        );
      case "status":
      case "ls":
      case "s":
        return showStatus();
      case "mute":
      case "unmute":
        for (const n of resolveNames(args)) muted[cmd === "mute" ? "add" : "delete"](n);
        return showStatus();
      case "clear":
        return out.write("\x1b[2J\x1b[H");
      case "help":
      case "?":
        return print(HELP);
      case "quit":
      case "exit":
      case "q":
        return quit();
      default:
        return info(`unknown command "${cmd}" — try ${bold("help")}`);
    }
  } catch (err) {
    info(c(31, err.message));
  }
}

let quitting = false;
async function quit() {
  if (quitting) process.exit(130); // second Ctrl-C: don't wait
  quitting = true;
  if (running().length) info("stopping everything…");
  await sup.stopAll();
  rl?.close();
  process.exit(0);
}

// Space toggles, Enter confirms, q/Esc cancels. Resolves to the ticked names.
function pick() {
  const rows = items.filter((i) => i.pick);
  const on = new Set(rows.filter((i) => i.default).map((i) => i.name));
  let cur = 0;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  const draw = (first) => {
    if (!first) out.write(`\x1b[${rows.length + 2}A`);
    out.write(
      `\x1b[J${bold("What should devctl start?")} ${dim("↑↓ move · space toggle · enter go · q quit")}\n`,
    );
    rows.forEach((r, n) => {
      const box = on.has(r.name) ? c(32, "[x]") : "[ ]";
      const arrow = n === cur ? c(36, "›") : " ";
      const warn = r.danger ? c(31, " (wipes local data)") : "";
      out.write(
        ` ${arrow} ${box} ${c(color[r.name], r.name.padEnd(width))}  ${dim(r.desc)}${warn}\n`,
      );
    });
    out.write("\n");
  };
  draw(true);
  return new Promise((resolve) => {
    const onKey = (_s, key) => {
      if (!key) return;
      if (key.name === "up") cur = (cur + rows.length - 1) % rows.length;
      else if (key.name === "down") cur = (cur + 1) % rows.length;
      else if (key.name === "space")
        on[on.has(rows[cur].name) ? "delete" : "add"](rows[cur].name);
      else if (
        key.name === "return" ||
        key.name === "q" ||
        key.name === "escape" ||
        (key.ctrl && key.name === "c")
      ) {
        process.stdin.off("keypress", onKey);
        process.stdin.setRawMode(false);
        return resolve(
          key.name === "return" ? rows.filter((r) => on.has(r.name)).map((r) => r.name) : null,
        );
      }
      draw(false);
    };
    process.stdin.on("keypress", onKey);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) return out.write(HELP + "\n");

  let initial = args;
  if (!initial.length && tty) {
    initial = await pick();
    if (initial === null) process.exit(0);
  }

  if (tty) {
    rl = readline.createInterface({
      input: process.stdin,
      output: out,
      prompt: c(1, "devctl› "),
      completer: (l) => {
        const all = [...items.map((i) => i.name), ...Object.keys(presets), "all"];
        const cmds = [
          "start",
          "stop",
          "restart",
          "status",
          "mute",
          "unmute",
          "clear",
          "help",
          "quit",
          "fresh",
          "up",
        ];
        const parts = l.split(/\s+/);
        const pool = parts.length > 1 ? all : cmds;
        const hits = pool.filter((x) => x.startsWith(parts.at(-1)));
        return [hits, parts.at(-1)];
      },
    });
    rl.on("line", (l) => exec(l).then(() => rl.prompt(true)));
    rl.on("SIGINT", quit);
    rl.on("close", () => quitting || quit());
    rl.prompt();
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, quit);

  if (initial.length) await exec(`start ${initial.join(" ")}`);
  else if (!tty) info("nothing to run; pass names, e.g. `devctl app stripe`");
  if (tty) info(`type ${bold("help")} for commands`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
