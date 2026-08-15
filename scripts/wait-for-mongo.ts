/**
 * Polls Mongo with the *app* user until it answers, so `dev:full` and CI are
 * deterministic instead of racing the container (docs/WORKFLOW.md §5.4).
 *
 * Connecting as the app user (not root) means a green wait also proves the
 * least-privilege user was created correctly by mongo-init.
 */
import { MongoClient } from "mongodb";
import { dbNameFromUri, requireEnv } from "./lib/db";

const TIMEOUT_MS = 60_000;
const INTERVAL_MS = 1_000;

async function main() {
  const uri = requireEnv("MONGODB_URI");
  const dbName = dbNameFromUri(uri);
  const redacted = uri.replace(/\/\/[^@]*@/, "//***:***@");
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = "";
  let attempt = 0;

  process.stdout.write(`[graft] waiting for mongo at ${redacted} `);

  while (Date.now() < deadline) {
    attempt++;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
    try {
      await client.connect();
      await client.db(dbName).command({ ping: 1 });
      await client.close();
      process.stdout.write(` ready (${attempt} attempt${attempt === 1 ? "" : "s"})\n`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      process.stdout.write(".");
      await client.close().catch(() => {});
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  process.stdout.write("\n");
  console.error(`[graft] mongo not ready after ${TIMEOUT_MS / 1000}s: ${lastError}`);
  console.error(
    "[graft] if credentials changed, the volume still holds the old ones — `npm run dev:db:nuke`",
  );
  process.exit(1);
}

main();
