/**
 * Polls Mongo with the *app* user until it answers, so `dev:full` and CI are
 * deterministic instead of racing the container (docs/WORKFLOW.md §5.4).
 *
 * Connecting as the app user (not root) means a green wait also proves the
 * least-privilege user was created correctly by mongo-init.
 *
 * GRAFT-09: also initiates the single-node replica set the compose files now
 * start Mongo with (`--replSet rs0`), so every other script and the app itself
 * always find it ready. This can't live in mongo-init/*.js:
 * docker-entrypoint-initdb.d scripts run against a temporary instance the
 * official image starts *without* replication, so `rs.initiate()` there fails
 * with "This node was not started with replication enabled." Root credentials
 * are needed — `replSetInitiate` is a cluster-admin action the least-privilege
 * app user does not and should not hold.
 */
import { MongoClient } from "mongodb";
import { dbNameFromUri, requireEnv } from "./lib/db";

const TIMEOUT_MS = 60_000;
const INTERVAL_MS = 1_000;

/** The replica set is a single member, always advertised as this — see
 * scripts/setup-env.ts's `directConnection=true` comment for why the app's
 * own connection string does not need to match this address. */
const REPLICA_SET_NAME = "rs0";
const REPLICA_SET_MEMBER = "localhost:27017";

async function waitFor(
  label: string,
  attempt: (client: MongoClient) => Promise<void>,
  client: MongoClient,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = "";
  let tries = 0;
  process.stdout.write(`[graft] waiting for ${label} `);
  while (Date.now() < deadline) {
    tries++;
    try {
      await attempt(client);
      process.stdout.write(` ready (${tries} attempt${tries === 1 ? "" : "s"})\n`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }
  process.stdout.write("\n");
  throw new Error(`${label} not ready after ${TIMEOUT_MS / 1000}s: ${lastError}`);
}

/** True once `rs.status()` no longer reports "not yet initialized" (code 94). */
async function isReplicaSetInitiated(client: MongoClient): Promise<boolean> {
  try {
    await client.db("admin").command({ replSetGetStatus: 1 });
    return true;
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 94) return false; // NotYetInitialized
    throw error;
  }
}

async function ensureReplicaSetInitiated(rootUri: string): Promise<void> {
  const client = new MongoClient(rootUri, { serverSelectionTimeoutMS: 2_000 });
  try {
    await waitFor(
      "mongo (root)",
      async (c) => {
        await c.connect();
      },
      client,
    );

    if (await isReplicaSetInitiated(client)) {
      console.log(`[graft] replica set '${REPLICA_SET_NAME}' already initiated`);
      return;
    }

    await client.db("admin").command({
      replSetInitiate: {
        _id: REPLICA_SET_NAME,
        members: [{ _id: 0, host: REPLICA_SET_MEMBER }],
      },
    });
    console.log(`[graft] replica set '${REPLICA_SET_NAME}' initiated`);

    await waitFor(
      "primary election",
      async (c) => {
        const hello = await c.db("admin").command({ hello: 1 });
        if (!hello.isWritablePrimary) throw new Error("no writable primary yet");
      },
      client,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const uri = requireEnv("MONGODB_URI");
  const dbName = dbNameFromUri(uri);
  const redacted = uri.replace(/\/\/[^@]*@/, "//***:***@");

  const appClient = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
  try {
    await waitFor(
      `mongo at ${redacted}`,
      async (c) => {
        await c.connect();
        await c.db(dbName).command({ ping: 1 });
      },
      appClient,
    );
  } catch (error) {
    console.error(`[graft] ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "[graft] if credentials changed, the volume still holds the old ones — `npm run dev:db:nuke`",
    );
    process.exit(1);
  } finally {
    await appClient.close().catch(() => {});
  }

  const rootUser = requireEnv("MONGO_ROOT_USER");
  const rootPassword = requireEnv("MONGO_ROOT_PASSWORD");
  const port = process.env.MONGO_PORT ?? "27017";
  const rootUri = `mongodb://${rootUser}:${rootPassword}@localhost:${port}/admin?authSource=admin&directConnection=true`;

  try {
    await ensureReplicaSetInitiated(rootUri);
  } catch (error) {
    console.error(
      `[graft] replica set initiation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

main();
