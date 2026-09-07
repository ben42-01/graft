/**
 * Graft — one-time local environment setup.
 *
 * Generates .env.dev and .env.qa from .env.example with per-machine random
 * credentials, plus an RS256 keypair in .keys/ for JWT signing.
 *
 * Everything it writes is gitignored. No credential Graft uses locally ever
 * exists in the repository — the committed compose files interpolate them from
 * these generated files at runtime.
 *
 * Idempotent: existing files are left untouched.
 *
 *   npm run setup            # verbose, run manually
 *   npm run setup -- --quiet # postinstall, stays out of the way
 */
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const log = (msg: string) => !quiet && console.log(msg);

/** URL-safe secret — no characters that need escaping inside a Mongo URI. */
const secret = (bytes = 24) => randomBytes(bytes).toString("base64url").replace(/[-_]/g, "");

type EnvSpec = {
  file: string;
  values: Record<string, string>;
};

function buildSpec(env: "dev" | "qa"): EnvSpec {
  const db = `graft_${env}`;
  const appUser = "graft_app";
  const appPassword = secret();
  const mongoPort = env === "dev" ? "27017" : "27018";
  const redisPort = env === "dev" ? "6379" : "6380";
  const s3Port = env === "dev" ? "9000" : "9002";

  return {
    file: join(root, `.env.${env}`),
    values: {
      APP_ENV: env,
      NODE_ENV: env === "dev" ? "development" : "test",
      MONGO_DB: db,
      MONGO_PORT: mongoPort,
      MONGO_ROOT_USER: "graft_root",
      MONGO_ROOT_PASSWORD: secret(),
      MONGO_APP_USER: appUser,
      MONGO_APP_PASSWORD: appPassword,
      // `directConnection=true` — the single-node replica set (docker-compose.*
      // "GRAFT-09: --replSet") advertises itself as `localhost:27017`
      // internally regardless of the host port it's mapped to (27018 for qa),
      // so full topology discovery would try to redial that literal address.
      // A direct connection skips discovery and talks to the seed host as-is,
      // which is all a single member ever needs.
      MONGODB_URI: `mongodb://${appUser}:${appPassword}@localhost:${mongoPort}/${db}?authSource=${db}&directConnection=true`,
      REDIS_PORT: redisPort,
      REDIS_URL: `redis://localhost:${redisPort}`,
      PORT: env === "dev" ? "3000" : "3100",
      APP_URL: `http://localhost:${env === "dev" ? "3000" : "3100"}`,
      // Object storage (docs/BACKEND.md §4). The access key is a fixed name
      // rather than a random one: it is MinIO's root *user*, and only the
      // secret half needs to differ per machine.
      S3_ENDPOINT: `http://localhost:${s3Port}`,
      S3_REGION: "us-east-1",
      S3_BUCKET: `graft-${env}-media`,
      S3_ACCESS_KEY_ID: "graft_media",
      S3_SECRET_ACCESS_KEY: secret(),
      S3_FORCE_PATH_STYLE: "true",
      S3_PORT: s3Port,
      S3_CONSOLE_PORT: env === "dev" ? "9001" : "9003",
      JWT_PRIVATE_KEY_PATH: ".keys/jwt-private.pem",
      JWT_PUBLIC_KEY_PATH: ".keys/jwt-public.pem",
      // GRAFT-15 — dummy Stripe test-mode values. STRIPE_WEBHOOK_SECRET is
      // fixed, not randomised like the Mongo/Redis credentials above: the
      // Bruno webhook suite (bruno/billing/webhook-idempotency.bru) signs its
      // fixture events with this exact literal, the same way seed-qa.ts's
      // QA_PASSWORD is a fixed value shared with bruno/environments/*.bru
      // rather than a per-machine secret. It is not a real Stripe credential
      // — HMAC verification only needs both sides to agree.
      STRIPE_SECRET_KEY: "sk_test_local_dummy_key",
      STRIPE_WEBHOOK_SECRET: "whsec_qa_fixture_only_2026",
      STRIPE_PRICE_PREMIUM_MONTHLY: "price_local_dummy_monthly",
      STRIPE_PRICE_PREMIUM_ANNUAL: "price_local_dummy_annual",
    },
  };
}

/**
 * Adds keys a newer template introduced to an env file that predates them,
 * leaving every existing line — and therefore every existing credential —
 * exactly as it was.
 *
 * Without this, adding a variable to `buildSpec` would only ever reach a fresh
 * checkout: every developer already holding a generated `.env.dev` would get
 * "left untouched" and then a startup failure about a variable they have no
 * obvious way to obtain. Rotation is still delete-and-regenerate; this only
 * ever appends what is missing.
 */
function topUpEnvFile({ file, values }: EnvSpec): boolean {
  const existing = readFileSync(file, "utf8");
  const present = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("="))),
  );
  const missing = Object.entries(values).filter(([key]) => !present.has(key));
  if (missing.length === 0) {
    log(`  = ${file.replace(root + "/", "")} already exists — left untouched`);
    return false;
  }
  const addition = [
    "",
    `# Added by \`npm run setup\` on ${new Date().toISOString()}`,
    ...missing.map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  writeFileSync(file, existing.replace(/\n*$/, "") + "\n" + addition, { mode: 0o600 });
  log(
    `  ~ ${file.replace(root + "/", "")} topped up with ${missing.length} new key(s): ${missing
      .map(([k]) => k)
      .join(", ")}`,
  );
  return true;
}

function writeEnvFile(spec: EnvSpec): boolean {
  const { file, values } = spec;
  if (existsSync(file)) return topUpEnvFile(spec);
  const body = [
    `# Generated by \`npm run setup\` on ${new Date().toISOString()}`,
    `# LOCAL CREDENTIALS — gitignored. Never commit this file.`,
    `# Delete it and re-run \`npm run setup\` to rotate; then \`npm run dev:db:nuke\`.`,
    "",
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  writeFileSync(file, body, { mode: 0o600 });
  log(`  + ${file.replace(root + "/", "")} created (mode 600)`);
  return true;
}

function writeMongoKeyFile(): boolean {
  // Its own subdirectory, not .keys/ directly: the compose files bind-mount the
  // whole directory into the mongo container (a single-file bind mount hits a
  // "bad file" permission-check quirk — see docker-compose.dev.yml), and JWT
  // signing material has no reason to be reachable from inside that container.
  const path = join(root, ".keys", "mongo", "keyfile");
  if (existsSync(path)) {
    log("  = .keys/mongo/keyfile already exists — left untouched");
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  // Internal cluster auth for the replica set (GRAFT-09) — required by mongod
  // the moment `--auth` and `--replSet` are combined, even for one member.
  // Mongo only checks that group/world have no permission bits set (mode 600),
  // not the owning uid, so this is readable from inside the container across
  // a bind mount regardless of which user the mongod process runs as.
  writeFileSync(path, secret(500), { mode: 0o600 });
  log("  + .keys/mongo/keyfile created (mode 600)");
  return true;
}

function writeKeypair(): boolean {
  const dir = join(root, ".keys");
  const privatePath = join(dir, "jwt-private.pem");
  const publicPath = join(dir, "jwt-public.pem");
  if (existsSync(privatePath)) {
    log("  = .keys/jwt-private.pem already exists — left untouched");
    return false;
  }
  mkdirSync(dir, { recursive: true });
  // RS256 per docs/BACKEND.md §3.1 — API nodes verify with the public key,
  // only the auth service holds the private key.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey, { mode: 0o644 });
  log("  + .keys/jwt-{private,public}.pem created (RS256, 2048-bit)");
  return true;
}

function main() {
  if (!existsSync(join(root, ".env.example"))) {
    console.error("[graft] .env.example missing — cannot derive local env files");
    process.exit(1);
  }

  log("\n[graft] local environment setup");
  const created = [
    writeEnvFile(buildSpec("dev")),
    writeEnvFile(buildSpec("qa")),
    writeKeypair(),
    writeMongoKeyFile(),
  ].some(Boolean);

  if (created) {
    log(
      "\n  Credentials are random and local to this machine.\n" +
        "  If Mongo was already initialised with different ones, run `npm run dev:db:nuke` first.\n",
    );
  } else {
    log("  nothing to do — environment already set up\n");
  }
}

main();
