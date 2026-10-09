/**
 * `graft login` — the browser sign-in (device authorization grant; server side
 * in src/server/services/device-auth.ts).
 *
 * The CLI never sees a password. It asks the server for a request, shows the
 * person a short code, and waits while they type it at <host>/device in a
 * browser where they are already signed in. The code is deliberately *not*
 * put in the URL: typing it from your own terminal is what proves the
 * terminal is yours.
 */
import { spawn } from "node:child_process";
import { hostname, platform, arch } from "node:os";
import { ApiError, GraftClient, parseEnvelope, refreshFromSetCookie } from "./client.js";
import { updateProfile, type Session } from "./config.js";
import { bold, dim, green, yellow, type Writer } from "./output.js";

type Start = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};
type Poll =
  | { status: "pending" | "slow_down"; interval: number }
  | { status: "approved"; accessToken: string; expiresAt: string; refreshToken: string };

export type LoginDeps = {
  sleep: (ms: number) => Promise<void>;
  openBrowser: (url: string) => boolean;
  now: () => number;
};

export const defaultLoginDeps: LoginDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  openBrowser,
  now: Date.now,
};

/** Best effort; prints the URL either way. False when it did not try. */
export function openBrowser(url: string): boolean {
  if (process.env.GRAFT_NO_BROWSER || process.env.SSH_CONNECTION || process.env.CI)
    return false;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function login(
  client: GraftClient,
  baseUrl: string,
  options: { browser: boolean; version: string },
  w: Writer,
  deps: LoginDeps = defaultLoginDeps,
): Promise<Session> {
  // Remember where this profile points before anything else, so the requests
  // below (and any later command) go to the URL the person gave.
  const previous = (
    await updateProfile(client.profileName, (p) => ({ ...p, baseUrl, session: p?.session }))
  )?.session;

  const started = (
    await client.request("POST", "/api/v1/auth/device", {
      anonymous: true,
      body: {
        client: {
          name: "graft",
          hostname: hostname(),
          platform: `${platform()}-${arch()}`,
          version: options.version,
        },
      },
    })
  ).data as Start;

  w.err("");
  w.err(`  ${yellow(w, "!")} Your one-time code: ${bold(w, started.userCode)}`);
  w.err(`  Open ${bold(w, started.verificationUri)} and enter it.`);
  const opened = options.browser && deps.openBrowser(started.verificationUri);
  w.err(
    dim(
      w,
      opened
        ? "  (opened your browser)"
        : "  (open that link in any browser where you are signed in to Graft)",
    ),
  );
  w.err("");

  const deadline = deps.now() + started.expiresIn * 1000;
  let interval = started.interval;
  let tokens: Extract<Poll, { status: "approved" }> | null = null;
  while (!tokens) {
    if (deps.now() > deadline)
      throw new Error("The code expired before it was approved. Run `graft login` again.");
    await deps.sleep(interval * 1000);
    let poll: Poll;
    try {
      poll = (
        await client.request("POST", "/api/v1/auth/device/token", {
          anonymous: true,
          body: { deviceCode: started.deviceCode },
        })
      ).data as Poll;
    } catch (error) {
      if (error instanceof ApiError && error.code === "FORBIDDEN")
        throw new Error("The request was denied in the browser.");
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
        throw new Error("The code expired or was already used. Run `graft login` again.");
      }
      throw error;
    }
    if (poll.status === "approved") tokens = poll;
    else interval = poll.interval;
  }

  const session: Session = {
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken,
  };
  await updateProfile(client.profileName, (p) => ({ baseUrl, ...p, session }));

  // Who did we just become? Stored so `whoami` and the prompt line need no call.
  const me = (await client.request("GET", "/api/v1/me")).data as {
    user: { email: string };
    tenant: { id: string; name: string };
  };
  const named: Session = {
    ...session,
    email: me.user.email,
    tenantId: me.tenant.id,
    tenantName: me.tenant.name,
  };
  await updateProfile(client.profileName, (p) =>
    p?.session?.refreshToken === session.refreshToken
      ? { ...p, session: { ...p.session, ...named } }
      : p,
  );

  // A second login on the same profile replaces the first; end the old one on
  // the server too rather than leave a live 30-day token behind.
  if (previous && previous.refreshToken !== session.refreshToken)
    await revoke(client, previous);

  w.err(
    `  ${green(w, "✓")} Signed in as ${bold(w, me.user.email)} · workspace ${bold(w, me.tenant.name)}`,
  );
  return named;
}

/**
 * Ends a session server-side: its access token joins the deny-list and its
 * refresh family is revoked. Logout needs a live access token, so a session
 * whose access token has lapsed is rotated once first. Best effort — an
 * already-dead session is fine.
 */
export async function revoke(
  client: GraftClient,
  session: Session,
  now = Date.now(),
): Promise<boolean> {
  try {
    let { accessToken, refreshToken } = session;
    if (Date.parse(session.accessExpiresAt) - now < 30_000) {
      const rotated = await client.raw("POST", "/api/v1/auth/refresh", {
        headers: { cookie: `graft_refresh=${refreshToken}` },
      });
      if (rotated.status !== 200) return false; // already revoked or expired
      const { data, headers } = await parseEnvelope(rotated);
      accessToken = (data as { accessToken: string }).accessToken;
      refreshToken = refreshFromSetCookie(headers) ?? refreshToken;
    }
    const response = await client.raw("POST", "/api/v1/auth/logout", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `graft_refresh=${refreshToken}`,
      },
    });
    return response.status === 204;
  } catch {
    return false;
  }
}
