/**
 * Where the CLI keeps who it is signed in as.
 *
 *   $GRAFT_CONFIG_DIR, else $XDG_CONFIG_HOME/graft, else ~/.config/graft
 *     config.json   profiles: base URL + session, mode 600 in a 700 directory
 *     .lock         held while a refresh token is being rotated
 *
 * One profile per Graft deployment you sign in to ("default", "qa", ...),
 * chosen with --profile or GRAFT_PROFILE.
 *
 * The refresh token is a 30-day credential. It sits in a file only this user
 * can read, the same way `gh` and `gcloud` keep theirs. An OS keychain is a
 * possible later step; personal API keys (for CI, no browser) are v2.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Session = {
  accessToken: string;
  /** ISO time the access token stops working. */
  accessExpiresAt: string;
  refreshToken: string;
  /** Who and where — shown by `whoami` without a network call. */
  email?: string;
  tenantId?: string;
  tenantName?: string;
};

export type Profile = {
  baseUrl: string;
  session?: Session;
};

export type Config = {
  version: 1;
  profiles: Record<string, Profile>;
};

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GRAFT_CONFIG_DIR) return env.GRAFT_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "graft");
}

const configFile = (dir: string) => join(dir, "config.json");

export function readConfig(dir = configDir()): Config {
  const file = configFile(dir);
  if (!existsSync(file)) return { version: 1, profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Config;
    return parsed && typeof parsed.profiles === "object"
      ? parsed
      : { version: 1, profiles: {} };
  } catch {
    throw new Error(`${file} is not valid JSON — fix or delete it, then run \`graft login\``);
  }
}

/** Atomic (write + rename) and private (600 in a 700 directory). */
export function writeConfig(config: Config, dir = configDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = configFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function profileName(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return flag || env.GRAFT_PROFILE || "default";
}

/** Read-modify-write of one profile, under the lock. */
export async function updateProfile(
  name: string,
  change: (profile: Profile | undefined) => Profile | undefined | Promise<Profile | undefined>,
  dir = configDir(),
): Promise<Profile | undefined> {
  return withLock(dir, async () => {
    const config = readConfig(dir);
    const next = await change(config.profiles[name]);
    if (next) config.profiles[name] = next;
    else delete config.profiles[name];
    writeConfig(config, dir);
    return next;
  });
}

/**
 * A cross-process lock around refresh-token rotation.
 *
 * Refresh tokens are single use, and presenting a used one revokes the whole
 * family (reuse detection) — the server cannot tell two of your own terminals
 * apart from a thief. So two `graft` processes refreshing at once would sign
 * you out. The lock makes the second one wait and then find the first one's
 * fresh token instead.
 */
export async function withLock<T>(
  dir: string,
  fn: () => T | Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock older than the timeout belongs to a process that died holding it.
      try {
        if (Date.now() - statSync(lock).mtimeMs > timeoutMs) rmSync(lock, { force: true });
      } catch {
        /* removed by its owner meanwhile */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
