/**
 * grant-platform-admin — the one supported way to create a platform admin
 * (GRAFT-27.1 AC8).
 *
 *   npm run admin:grant -- ops@example.com
 *   npm run admin:grant -- ops@example.com --revoke
 *
 * There is no self-service path and no HTTP endpoint for this, by design
 * (issue Scope). Granting the flag over the API would mean the admin surface
 * could widen itself; keeping it here means the grant requires database
 * credentials and leaves a shell trail, and revoking it is one command that
 * takes effect on the target's *next request* — the flag is re-read from this
 * document every time (src/server/auth/platform-admin.ts).
 *
 * The logic is exported and unit-tested against a collection double
 * (grant-platform-admin.test.ts); only `main()` touches a real database, and
 * only when this file is executed directly.
 */
import { fileURLToPath } from "node:url";
import { connect } from "./lib/db";

/** Just the one verb this script needs — so the test can supply a double. */
/** Only the operators this script uses — `$set` to grant, `$unset` to revoke. */
export type PlatformAdminUpdate = {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
};

export type PlatformAdminUsers = {
  updateOne(
    filter: { email: string },
    update: PlatformAdminUpdate,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
};

export type GrantArgs = { email: string; revoke: boolean };

export type GrantResult = {
  /** Whether an account with that address exists at all. */
  matched: boolean;
  /** False when the flag was already in the requested state — still a success. */
  changed: boolean;
  revoke: boolean;
};

/**
 * Deliberately crude: this is a shape check to catch a fat-fingered argument,
 * not an address validator. The database's unique index on `users.email` is
 * what decides whether an address is real.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs(argv: readonly string[]): GrantArgs | null {
  const revoke = argv.includes("--revoke");
  const rest = argv.filter((arg) => arg !== "--revoke");
  if (rest.length !== 1) return null;
  const email = rest[0]!;
  return EMAIL_SHAPE.test(email) ? { email, revoke } : null;
}

/**
 * Set or clear the flag on exactly one account.
 *
 * `updateOne`, never `updateMany`: a filter that matched two rows would grant
 * platform admin to someone nobody named. Revoking `$unset`s rather than
 * setting `false` — the gate refuses an absent field and a `false` one
 * identically, and absent is the smaller document and the more honest one.
 */
export async function setPlatformAdmin(
  users: PlatformAdminUsers,
  email: string,
  revoke: boolean,
): Promise<GrantResult> {
  const now = new Date();
  const update: PlatformAdminUpdate = revoke
    ? { $unset: { isPlatformAdmin: "" }, $set: { updatedAt: now } }
    : { $set: { isPlatformAdmin: true, updatedAt: now } };

  const { matchedCount, modifiedCount } = await users.updateOne({ email }, update);
  return { matched: matchedCount > 0, changed: modifiedCount > 0, revoke };
}

/**
 * The address is echoed back because the operator typed it a moment ago and
 * needs to confirm they typed it correctly. Nothing else about the account is
 * read or printed — no name, no hash, no token, no id (AC8: "prints no
 * secret").
 */
function report(email: string, result: GrantResult): void {
  const verb = result.revoke ? "revoked" : "granted";
  if (!result.changed) {
    console.log(`[graft] platform admin already ${verb} for ${email} — nothing to do`);
    return;
  }
  console.log(`[graft] platform admin ${verb} for ${email}`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(
      "[graft] usage: npm run admin:grant -- <email> [--revoke]\n" +
        "        exactly one email address, which must already have an account.",
    );
    return 2;
  }

  const { client, db } = await connect();
  try {
    const result = await setPlatformAdmin(
      db.collection("users") as unknown as PlatformAdminUsers,
      args.email,
      args.revoke,
    );
    if (!result.matched) {
      // Non-zero exit, so a typo in a runbook or a CI step fails loudly rather
      // than reporting success for an account that does not exist.
      console.error(`[graft] no account exists for ${args.email} — nothing was changed`);
      return 1;
    }
    report(args.email, result);
    return 0;
  } finally {
    await client.close();
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("[graft] granting platform admin failed:", error);
      process.exit(1);
    });
}
