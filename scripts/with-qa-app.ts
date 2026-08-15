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

const PORT = Number(process.env.PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 60_000;

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("[graft] usage: tsx scripts/with-qa-app.ts <command...>");
  process.exit(1);
}

let server: ChildProcess | null = null;

function stopServer() {
  if (server && server.exitCode === null && !server.killed) {
    server.kill("SIGTERM");
  }
  server = null;
}

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

async function main() {
  console.log(`[graft] starting QA app on :${PORT}`);
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
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

  stopServer();
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopServer();
    process.exit(130);
  });
}

main().catch((error) => {
  console.error(`[graft] ${error instanceof Error ? error.message : error}`);
  stopServer();
  process.exit(1);
});
