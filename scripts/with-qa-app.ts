/**
 * Runs a command with the QA app alive in front of it, then tears it down.
 *
 *   tsx scripts/with-qa-app.ts npm run test:api
 *
 * The Bruno suite needs a running server to talk to; without this, `verify:full`
 * would run the contract tests against nothing and "pass" by never connecting.
 * Starts `next start` on the QA port, waits for /api/health, runs the command,
 * and always kills the server — including on failure or Ctrl-C.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 60_000;
const REAP_GRACE_MS = 5_000;

const command = process.argv.slice(2);

/** True if something is already listening on `port` — used for the pre-flight check and nothing else. */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * AC2 — fail fast instead of spending the 60s startup timeout finding out the
 * port was never free. `checker` is injectable so tests don't touch a real socket.
 */
export async function preflightPort(
  port: number,
  checker: (port: number) => Promise<boolean> = isPortInUse,
): Promise<void> {
  if (await checker(port)) {
    throw new Error(
      `[graft] port ${port} is already in use — a previous run may not have exited cleanly. ` +
        `Find and stop it: lsof -i:${port}  (or)  kill $(lsof -t -i:${port})`,
    );
  }
}

/**
 * AC1 — reap the child however the script exits. `next start` (via npx) can spawn
 * its own next-server child, so signalling only the direct pid can leave that
 * grandchild holding the port. The server is spawned detached (its own process
 * group), so `-pid` targets the whole tree; SIGKILL is the fallback if SIGTERM
 * doesn't clear it within the grace period.
 */
export async function stopChild(
  child: ChildProcess | null,
  opts: { graceMs?: number } = {},
): Promise<void> {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null || child.killed) return;

  const pid = child.pid;
  const graceMs = opts.graceMs ?? REAP_GRACE_MS;

  function signal(sig: NodeJS.Signals) {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child?.kill(sig);
      } catch {
        // already gone — nothing left to signal
      }
    }
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardCap);
      resolve();
    };

    child.once("exit", finish);
    signal("SIGTERM");

    const killTimer = setTimeout(() => signal("SIGKILL"), graceMs);
    // Belt-and-braces: if `exit` never fires (e.g. already reaped by the OS), don't hang forever.
    const hardCap = setTimeout(finish, graceMs + 1_000);
  });
}

/** Runs cleanup without letting a reaping problem override the command's own exit code (AC3). */
export async function cleanup(
  child: ChildProcess | null,
): Promise<{ ok: boolean; error?: unknown }> {
  try {
    await stopChild(child);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

let server: ChildProcess | null = null;

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`app exited with code ${server.exitCode} before becoming healthy`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`app did not answer ${BASE}/api/health within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

async function reportAndExit(code: number): Promise<never> {
  const result = await cleanup(server);
  if (!result.ok) {
    console.error(
      `[graft] cleanup problem (did not affect the test result above): ${
        result.error instanceof Error ? result.error.message : result.error
      }`,
    );
  }
  process.exit(code);
}

async function main() {
  if (command.length === 0) {
    console.error("[graft] usage: tsx scripts/with-qa-app.ts <command...>");
    process.exit(1);
  }

  await preflightPort(PORT);

  console.log(`[graft] starting QA app on :${PORT}`);
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });
  server.stdout?.on("data", (d) => process.stdout.write(`  [app] ${d}`));
  server.stderr?.on("data", (d) => process.stderr.write(`  [app] ${d}`));

  await waitForHealth();
  console.log(`[graft] app healthy — running: ${command.join(" ")}\n`);

  const code = await new Promise<number>((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: process.env });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", (error) => {
      console.error(`[graft] failed to run command: ${error.message}`);
      resolve(1);
    });
  });

  await reportAndExit(code);
}

// Guard so importing this module (e.g. from the unit tests) doesn't launch the
// app or call process.exit — only running it directly via `tsx` does.
const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void reportAndExit(130);
    });
  }

  main().catch(async (error) => {
    console.error(`[graft] ${error instanceof Error ? error.message : error}`);
    await reportAndExit(1);
  });
}
