// The catalogue of things devctl can run. Add an entry here to make it selectable.
//
//   kind: "task"    runs to completion (db up, seed, ...)
//   kind: "service" long-running; can be stopped and restarted
//   needs:          tasks run (once per session) before the service starts
//   pick:           offered in the startup picker
//   default:        pre-ticked in the startup picker
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const items = [
  {
    name: "db",
    kind: "task",
    cmd: "npm run dev:db",
    desc: "Start Mongo / Redis / MinIO containers",
  },
  {
    name: "seed",
    kind: "task",
    needs: ["db"],
    cmd: "npm run dev:seed",
    desc: "Wait for Mongo, create indexes + bucket, seed dev data",
  },
  {
    name: "reset",
    kind: "task",
    needs: ["db"],
    cmd: "npm run dev:reset",
    desc: "Wipe collections and re-seed (containers stay up)",
    danger: true,
  },
  {
    name: "nuke",
    kind: "task",
    cmd: "npm run dev:db:nuke",
    desc: "Remove containers AND volumes (all local data)",
    danger: true,
    pick: true,
    invalidates: ["db", "seed"],
  },
  {
    name: "down",
    kind: "task",
    cmd: "npm run dev:db:down",
    desc: "Stop containers, keep volumes",
    invalidates: ["db"],
  },
  {
    name: "app",
    kind: "service",
    needs: ["db", "seed"],
    cmd: "npm run dev",
    desc: "Next.js dev server (turbopack) on :3000",
    pick: true,
    default: true,
  },
  {
    name: "stripe",
    kind: "service",
    cmd: "bash tools/devctl/scripts/stripe-webhook.sh",
    desc: "Stripe CLI webhook forwarding to the dev server",
    pick: true,
    default: true,
  },
];

// Named combos for the `up` command, e.g. `fresh` = nuke the data, then bring everything up.
export const presets = {
  up: ["app", "stripe"],
  fresh: ["nuke", "app", "stripe"],
};

export const find = (name) => items.find((i) => i.name === name);
