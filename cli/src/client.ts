/**
 * Talks to a Graft deployment as the signed-in person.
 *
 * Every response is Graft's envelope — `{ data, meta }` or `{ error }` — and is
 * unwrapped here, so commands deal in data and `ApiError`s only.
 *
 * Sessions are the same ones the web app uses: a 15-minute access token sent
 * as `Authorization: Bearer`, and a 30-day refresh token. A CLI has no cookie
 * jar, so the refresh token is presented to `/auth/refresh` as the
 * `graft_refresh` cookie it would be in a browser, and the rotated one is read
 * back out of `Set-Cookie`.
 *
 * GRAFT_TOKEN, when set, is used as the access token as-is and never
 * refreshed — for one-off scripts that already hold a token.
 */
import { configDir, readConfig, updateProfile, type Profile, type Session } from "./config.js";

export const REFRESH_COOKIE = "graft_refresh";
/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Not signed in, or the session cannot be renewed. Exit code 3. */
export class AuthRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequired";
  }
}

export type Envelope = {
  data: unknown;
  meta: Record<string, unknown>;
  status: number;
  headers: Headers;
};

export type RequestOptions = {
  query?: Record<string, string | string[]>;
  body?: unknown;
  /** Send no Authorization header (the public and device-login endpoints). */
  anonymous?: boolean;
  headers?: Record<string, string>;
};

export type ClientDeps = {
  fetch: typeof fetch;
  now: () => number;
  env: NodeJS.ProcessEnv;
  dir: string;
};

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: RequestOptions["query"],
): string {
  const url = new URL(
    path.startsWith("/") ? path : `/${path}`,
    baseUrl.replace(/\/+$/, "") + "/",
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  return url.toString();
}

/** The `graft_refresh` value out of a response's Set-Cookie headers. */
export function refreshFromSetCookie(headers: Headers): string | null {
  const all =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z_]+=)/);
  for (const cookie of all) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq).trim() === REFRESH_COOKIE) return pair.slice(eq + 1).trim() || null;
  }
  return null;
}

export async function parseEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        response.status,
        "BAD_RESPONSE",
        `Expected JSON from the server, got: ${text.slice(0, 120)}`,
      );
    }
  }
  const envelope = (body ?? {}) as {
    data?: unknown;
    meta?: Record<string, unknown>;
    error?: { code?: string; message?: string; requestId?: string; details?: unknown };
  };
  if (!response.ok || envelope.error) {
    const e = envelope.error ?? {};
    throw new ApiError(
      response.status,
      e.code ?? `HTTP_${response.status}`,
      e.message ?? response.statusText ?? "Request failed",
      e.requestId ?? response.headers.get("x-request-id") ?? undefined,
      e.details,
    );
  }
  return {
    data: envelope.data ?? null,
    meta: envelope.meta ?? {},
    status: response.status,
    headers: response.headers,
  };
}

export class GraftClient {
  private readonly deps: ClientDeps;

  constructor(
    readonly profileName: string,
    deps: Partial<ClientDeps> = {},
  ) {
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? Date.now,
      env: deps.env ?? process.env,
      dir: deps.dir ?? configDir(deps.env ?? process.env),
    };
  }

  profile(): Profile | undefined {
    return readConfig(this.deps.dir).profiles[this.profileName];
  }

  get baseUrl(): string {
    const url = this.deps.env.GRAFT_URL || this.profile()?.baseUrl;
    if (!url) {
      throw new AuthRequired(
        `No Graft URL for profile '${this.profileName}'. Run \`graft login --url https://your-graft-host\`.`,
      );
    }
    return url;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Envelope> {
    const send = (token: string | null) =>
      this.raw(method, path, {
        ...options,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
      });

    if (options.anonymous) return parseEnvelope(await send(null));

    let response = await send(await this.accessToken());
    // A token can be revoked or rejected before its clock runs out (logout
    // elsewhere, a key rotation). One forced refresh, then believe the server.
    if (response.status === 401 && !this.deps.env.GRAFT_TOKEN) {
      response = await send(await this.accessToken({ force: true }));
    }
    return parseEnvelope(response);
  }

  /** One request, no envelope handling. */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const hasBody = options.body !== undefined;
    return this.deps.fetch(buildUrl(this.baseUrl, path, options.query), {
      method: method.toUpperCase(),
      headers: {
        accept: "application/json",
        "user-agent": "graft-cli",
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      redirect: "manual",
    });
  }

  /** A usable access token, refreshing (under the lock) when it is about to expire. */
  async accessToken({ force = false } = {}): Promise<string> {
    if (this.deps.env.GRAFT_TOKEN) return this.deps.env.GRAFT_TOKEN;
    const current = this.profile()?.session;
    if (!current)
      throw new AuthRequired(
        `Not signed in (profile '${this.profileName}'). Run \`graft login\`.`,
      );
    if (!force && this.fresh(current)) return current.accessToken;
    return (await this.rotate(current)).accessToken;
  }

  private fresh(session: Session): boolean {
    return Date.parse(session.accessExpiresAt) - this.deps.now() > REFRESH_MARGIN_MS;
  }

  private async rotate(seen: Session): Promise<Session> {
    let result: Session | undefined;
    let failure: Error | undefined;
    await updateProfile(
      this.profileName,
      async (profile) => {
        const session = profile?.session;
        if (!profile || !session) {
          failure = new AuthRequired("Signed out meanwhile. Run `graft login`.");
          return profile;
        }
        // Another graft process rotated it while we waited for the lock.
        if (session.refreshToken !== seen.refreshToken && this.fresh(session)) {
          result = session;
          return profile;
        }
        const response = await this.raw("POST", "/api/v1/auth/refresh", {
          headers: { cookie: `${REFRESH_COOKIE}=${session.refreshToken}` },
        });
        if (response.status === 401) {
          failure = new AuthRequired(
            "Your session has expired or was revoked. Run `graft login` again.",
          );
          return { ...profile, session: undefined };
        }
        const { data, headers } = await parseEnvelope(response);
        const body = data as { accessToken: string; expiresAt: string };
        const refreshToken = refreshFromSetCookie(headers);
        if (!refreshToken) {
          failure = new Error("The server rotated the session but sent no new refresh token.");
          return { ...profile, session: undefined };
        }
        result = {
          ...session,
          accessToken: body.accessToken,
          accessExpiresAt: body.expiresAt,
          refreshToken,
        };
        return { ...profile, session: result };
      },
      this.deps.dir,
    );
    if (failure) throw failure;
    return result!;
  }
}
