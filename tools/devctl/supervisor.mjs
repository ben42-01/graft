// Spawns, tracks and kills child processes. No UI in here.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { ROOT, find } from "./services.mjs";

const KILL_GRACE_MS = 5000;

export class Supervisor extends EventEmitter {
  /** name -> { child, status, code, startedAt }. status: running | stopped | exited | failed */
  procs = new Map();
  /** tasks completed successfully this session (so `start app` doesn't reseed every restart) */
  done = new Set();
  /** task name -> promise, so two services needing `db` at once share one run */
  #inflight = new Map();

  status(name) {
    return this.procs.get(name)?.status ?? (this.done.has(name) ? "done" : "idle");
  }

  isRunning(name) {
    return this.procs.get(name)?.status === "running";
  }

  /** Run `name`, first running any unmet `needs`. Resolves true on success / service launched. */
  async start(name, { force = false } = {}) {
    const item = find(name);
    if (!item) throw new Error(`unknown item "${name}"`);
    if (this.isRunning(name)) return true;

    for (const dep of item.needs ?? []) {
      if (this.done.has(dep)) continue;
      if (!(await this.start(dep))) return false;
    }
    if (item.kind === "task") {
      if (this.done.has(name) && !force) return true;
      if (this.#inflight.has(name)) return this.#inflight.get(name);
      const run = this.#spawn(item).then((ok) => {
        this.#inflight.delete(name);
        if (ok) {
          this.done.add(name);
          for (const stale of item.invalidates ?? []) this.done.delete(stale);
        }
        return ok;
      });
      this.#inflight.set(name, run);
      return run;
    }
    return this.#spawn(item);
  }

  #spawn(item) {
    return new Promise((resolve) => {
      // detached => own process group, so one signal reaches npm -> dotenv -> next -> workers.
      const child = spawn(item.cmd, {
        cwd: ROOT,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1" },
      });
      const proc = { child, status: "running", code: null, startedAt: Date.now() };
      this.procs.set(item.name, proc);
      this.emit("change", item.name);

      for (const stream of [child.stdout, child.stderr]) {
        let buf = "";
        stream.on("data", (chunk) => {
          buf += chunk.toString();
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          for (const line of lines) this.emit("line", item.name, line);
        });
        stream.on("end", () => buf && this.emit("line", item.name, buf));
      }

      // A task resolves when it finishes; a service resolves once it has survived startup.
      let settled = false;
      const settle = (v) => !settled && ((settled = true), resolve(v));
      if (item.kind === "service") setTimeout(() => settle(proc.status === "running"), 1500);

      child.on("error", (err) => {
        proc.status = "failed";
        this.emit("line", item.name, `spawn error: ${err.message}`);
        this.emit("change", item.name);
        settle(false);
      });
      child.on("exit", (code, signal) => {
        proc.code = code;
        if (proc.status === "running") proc.status = code === 0 ? "exited" : "failed";
        this.emit("exit", item.name, code, signal, proc.status);
        this.emit("change", item.name);
        settle(code === 0);
      });
    });
  }

  /** SIGTERM the whole group, SIGKILL if it hasn't gone after the grace period. */
  async stop(name) {
    const proc = this.procs.get(name);
    if (!proc || proc.status !== "running") return false;
    proc.status = "stopped";
    const { child } = proc;
    const exited = new Promise((r) => child.once("exit", r));
    this.#signal(child, "SIGTERM");
    const timer = setTimeout(() => this.#signal(child, "SIGKILL"), KILL_GRACE_MS);
    await exited;
    clearTimeout(timer);
    return true;
  }

  async restart(name) {
    await this.stop(name);
    return this.start(name, { force: true });
  }

  async stopAll() {
    const running = [...this.procs.keys()].filter((n) => this.isRunning(n));
    await Promise.all(running.map((n) => this.stop(n)));
  }

  #signal(child, sig) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* group already gone */
    }
  }
}
