import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  AuthRequired,
  GraftClient,
  buildUrl,
  parseEnvelope,
  refreshFromSetCookie,
} from "./client";
import { readConfig, writeConfig, type Session } from "./config";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const later = (ms: number) => new Date(NOW + ms).toISOString();

let dir: string;
const session = (over: Partial<Session> = {}): Session => ({
  accessToken: "access-1",
  accessExpiresAt: later(10 * 60_000),
  refreshToken: "t.refresh-1",
  ...over,
});
const seed = (s: Session | undefined) =>
  writeConfig(
    { version: 1, profiles: { default: { baseUrl: "https://graft.test", session: s } } },
    dir,
  );

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const refreshed = (n: number) =>
  json(
    200,
    { data: { accessToken: `access-${n}`, expiresAt: later(15 * 60_000) } },
    {
      "set-cookie": `graft_refresh=t.refresh-${n}; Path=/api/v1/auth; HttpOnly; Secure`,
    },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graft-cli-"));
});

const client = (fetch: typeof globalThis.fetch, env: Record<string, string> = {}) =>
  new GraftClient("default", { fetch, dir, env: env as NodeJS.ProcessEnv, now: () => NOW });

describe("helpers", () => {
  it("builds URLs with repeated query values and tolerates trailing slashes", () => {
    expect(
      buildUrl("https://g.test/", "/api/v1/orders", { status: ["a", "b"], q: "x y" }),
    ).toBe("https://g.test/api/v1/orders?status=a&status=b&q=x+y");
  });

  it("finds the refresh cookie among several Set-Cookie headers", () => {
    const headers = new Headers();
    headers.append("set-cookie", "graft_access=jwt; Path=/");
    headers.append("set-cookie", "graft_refresh=t.new; Path=/api/v1/auth");
    expect(refreshFromSetCookie(headers)).toBe("t.new");
    expect(refreshFromSetCookie(new Headers())).toBeNull();
  });

  it("turns an error envelope into an ApiError carrying code and request id", async () => {
    const error = await parseEnvelope(
      json(404, { error: { code: "NOT_FOUND", message: "No such order", requestId: "req-1" } }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND", requestId: "req-1" });
  });

  it("reports a non-JSON response instead of crashing", async () => {
    await expect(
      parseEnvelope(new Response("<html>bad gateway", { status: 502 })),
    ).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
});

describe("sessions", () => {
  it("uses a fresh access token as-is", async () => {
    seed(session());
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { data: { ok: true } }));
    await client(fetch).request("GET", "/api/v1/me");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer access-1",
    });
  });

  it("refreshes an expiring token via the refresh cookie and keeps the rotated one", async () => {
    seed(session({ accessExpiresAt: later(30_000) }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/auth/refresh") ? refreshed(2) : json(200, { data: {} }),
    );
    await client(fetch).request("GET", "/api/v1/me");
    const [refreshUrl, refreshInit] = fetch.mock.calls[0];
    expect(String(refreshUrl)).toBe("https://graft.test/api/v1/auth/refresh");
    expect((refreshInit as RequestInit).headers).toMatchObject({
      cookie: "graft_refresh=t.refresh-1",
    });
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer access-2",
    });
    expect(readConfig(dir).profiles.default.session).toMatchObject({
      accessToken: "access-2",
      refreshToken: "t.refresh-2",
    });
  });

  it("retries once with a forced refresh when the server rejects a token early", async () => {
    seed(session());
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/auth/refresh")) return refreshed(2);
      return ++calls === 1
        ? json(401, { error: { code: "UNAUTHORIZED", message: "no" } })
        : json(200, { data: 1 });
    });
    await expect(client(fetch).request("GET", "/api/v1/me")).resolves.toMatchObject({
      data: 1,
    });
  });

  it("drops a dead session and asks to log in again", async () => {
    seed(session({ accessExpiresAt: later(0) }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
    );
    await expect(client(fetch).request("GET", "/api/v1/me")).rejects.toBeInstanceOf(
      AuthRequired,
    );
    expect(readConfig(dir).profiles.default.session).toBeUndefined();
  });

  it("rotates exactly once when many requests race on an expired token", async () => {
    seed(session({ accessExpiresAt: later(0) }));
    let rotations = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("/auth/refresh")) {
        await new Promise((r) => setTimeout(r, 20));
        return refreshed(1 + ++rotations);
      }
      return json(200, { data: {} });
    });
    await Promise.all(
      Array.from({ length: 5 }, () => client(fetch).request("GET", "/api/v1/me")),
    );
    expect(rotations).toBe(1);
  });

  it("uses GRAFT_TOKEN verbatim and never refreshes it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
    );
    await expect(
      client(fetch, { GRAFT_TOKEN: "ci-token", GRAFT_URL: "https://graft.test" }).request(
        "GET",
        "/api/v1/me",
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains how to sign in when there is no session", async () => {
    seed(undefined);
    await expect(
      client(vi.fn<typeof globalThis.fetch>()).request("GET", "/api/v1/me"),
    ).rejects.toThrow(/graft login/);
  });

  it("keeps the config private", () => {
    seed(session());
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("t.refresh-1");
  });
});

describe("GRAFT_READONLY", () => {
  it("refuses anything but GET before it reaches the network", async () => {
    seed(session());
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { data: {} }));
    const ro = client(fetch, { GRAFT_READONLY: "1" });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      await expect(ro.request(method, "/api/v1/orders")).rejects.toThrow(/GRAFT_READONLY/);
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(ro.request("GET", "/api/v1/orders")).resolves.toMatchObject({ data: {} });
  });

  it("still refreshes an expiring token — that is not a change to your data", async () => {
    seed(session({ accessExpiresAt: later(0) }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/auth/refresh") ? refreshed(2) : json(200, { data: 1 }),
    );
    await expect(
      client(fetch, { GRAFT_READONLY: "true" }).request("GET", "/api/v1/me"),
    ).resolves.toMatchObject({ data: 1 });
  });
});
