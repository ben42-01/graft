import { describe, expect, it } from "vitest";
import { parseArgs, setPlatformAdmin, type PlatformAdminUsers } from "./grant-platform-admin";

/**
 * GRAFT-27.1 AC8 — the only supported way to create a platform admin.
 *
 * There is deliberately no HTTP path for this (issue Scope: "granting/revoking
 * the flag over HTTP" is out of scope), so this script *is* the grant boundary
 * and gets tested like one: it must touch exactly one existing user, be safe to
 * run twice, fail loudly on an unknown address, and print nothing that would be
 * unwise to leave in a shell history or a CI log.
 */

/** A `users` collection double that records the filter and update it was given. */
function usersDouble(existing: string[]) {
  const calls: { filter: unknown; update: unknown }[] = [];
  const flagged = new Set<string>();
  const users: PlatformAdminUsers = {
    async updateOne(filter, update) {
      calls.push({ filter, update });
      const email = (filter as { email: string }).email;
      if (!existing.includes(email)) return { matchedCount: 0, modifiedCount: 0 };
      // A revoke carries `$unset` (alongside an `$set` for updatedAt); a grant
      // carries only `$set`. The double reads it the way Mongo would.
      const granting = !("$unset" in (update as object));
      const was = flagged.has(email);
      if (granting) flagged.add(email);
      else flagged.delete(email);
      return { matchedCount: 1, modifiedCount: was === granting ? 0 : 1 };
    },
  };
  return { users, calls, flagged };
}

describe("parseArgs", () => {
  it("reads an email and the optional --revoke flag", () => {
    expect(parseArgs(["ops@graft.test"])).toEqual({ email: "ops@graft.test", revoke: false });
    expect(parseArgs(["ops@graft.test", "--revoke"])).toEqual({
      email: "ops@graft.test",
      revoke: true,
    });
    expect(parseArgs(["--revoke", "ops@graft.test"])).toEqual({
      email: "ops@graft.test",
      revoke: true,
    });
  });

  it("refuses no argument, two addresses, or something that is not an address", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["a@b.test", "c@d.test"])).toBeNull();
    expect(parseArgs(["not-an-email"])).toBeNull();
  });
});

describe("setPlatformAdmin", () => {
  it("AC8 — sets the flag on exactly one existing user", async () => {
    const { users, calls, flagged } = usersDouble(["ops@graft.test", "other@graft.test"]);
    const result = await setPlatformAdmin(users, "ops@graft.test", false);

    expect(result).toEqual({ matched: true, changed: true, revoke: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filter).toEqual({ email: "ops@graft.test" });
    expect(calls[0]!.update).toMatchObject({ $set: { isPlatformAdmin: true } });
    expect([...flagged]).toEqual(["ops@graft.test"]);
  });

  it("AC8 — is idempotent: a second grant matches, changes nothing, and still succeeds", async () => {
    const { users, flagged } = usersDouble(["ops@graft.test"]);
    await setPlatformAdmin(users, "ops@graft.test", false);
    const again = await setPlatformAdmin(users, "ops@graft.test", false);

    expect(again).toEqual({ matched: true, changed: false, revoke: false });
    expect([...flagged]).toEqual(["ops@graft.test"]);
  });

  it("AC8 — --revoke clears the flag, and is likewise idempotent", async () => {
    const { users, calls, flagged } = usersDouble(["ops@graft.test"]);
    await setPlatformAdmin(users, "ops@graft.test", false);

    expect(await setPlatformAdmin(users, "ops@graft.test", true)).toEqual({
      matched: true,
      changed: true,
      revoke: true,
    });
    expect(await setPlatformAdmin(users, "ops@graft.test", true)).toEqual({
      matched: true,
      changed: false,
      revoke: true,
    });
    expect(flagged.size).toBe(0);
    // Unset rather than `false`: an absent field and a false one are both
    // refused by the gate, and absent is the smaller document.
    expect(calls.at(-1)!.update).toMatchObject({ $unset: { isPlatformAdmin: "" } });
  });

  it("AC8 — reports no match for an unknown address, and writes nothing", async () => {
    const { users, flagged } = usersDouble(["ops@graft.test"]);
    const result = await setPlatformAdmin(users, "nobody@graft.test", false);

    expect(result).toEqual({ matched: false, changed: false, revoke: false });
    expect(flagged.size).toBe(0);
  });

  it("AC8 — never writes anything but the flag", async () => {
    const { users, calls } = usersDouble(["ops@graft.test"]);
    await setPlatformAdmin(users, "ops@graft.test", false);
    const update = calls[0]!.update as Record<string, Record<string, unknown>>;
    expect(Object.keys(update.$set!)).toEqual(["isPlatformAdmin", "updatedAt"]);
    expect(JSON.stringify(update)).not.toContain("password");
  });
});
