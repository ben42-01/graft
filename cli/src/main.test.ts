import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, AuthRequired } from "./client";
import { applySet, buildQuery, report, run, UsageError, type Io } from "./main";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    w: { out: (s) => out.push(s), err: (s) => err.push(s), color: false },
    stdin: async () => "",
    isTTY: false,
  };
  return { io, out, err };
};

describe("request building", () => {
  it("builds nested bodies from --set, parsing JSON values", () => {
    const body = {};
    applySet(body, "name=Ada");
    applySet(body, "data.age=36");
    applySet(body, 'data.tags=["a"]');
    expect(body).toEqual({ name: "Ada", data: { age: 36, tags: ["a"] } });
  });

  it("rejects malformed --set and --query", () => {
    expect(() => applySet({}, "novalue")).toThrow(UsageError);
    expect(() => buildQuery({ query: ["=x"] })).toThrow(UsageError);
  });

  it("collects repeated query keys", () => {
    expect(buildQuery({ query: ["status=a", "status=b", "limit=5"] })).toEqual({
      status: ["a", "b"],
      limit: ["5"],
    });
  });
});

describe("exit codes", () => {
  const w = capture().io.w;
  it.each([
    [new UsageError("x"), 2],
    [new AuthRequired("x"), 3],
    [new ApiError(401, "UNAUTHORIZED", "x"), 3],
    [new ApiError(403, "FORBIDDEN", "x"), 4],
    [new ApiError(404, "NOT_FOUND", "x"), 5],
    [new ApiError(400, "VALIDATION_FAILED", "x"), 1],
    [new ApiError(500, "INTERNAL", "x"), 6],
    [new Error("fetch failed"), 6],
  ])("%s → %i", (error, code) => expect(report(error, w)).toBe(code));

  it("shows field errors and the request id for support", () => {
    const { io, err } = capture();
    report(
      new ApiError(400, "VALIDATION_FAILED", "Invalid", "req-9", {
        fields: { email: "Required" },
      }),
      io.w,
    );
    expect(err.join("\n")).toContain("email: Required");
    expect(err.join("\n")).toContain("req-9");
  });
});

describe("run", () => {
  const env = () =>
    ({
      GRAFT_CONFIG_DIR: mkdtempSync(join(tmpdir(), "graft-cli-")),
    }) as unknown as NodeJS.ProcessEnv;

  it("prints help", async () => {
    const { io, out } = capture();
    expect(await run(["help"], io, env())).toBe(0);
    expect(out.join("\n")).toContain("login [--url URL]");
  });

  it("lists an area's commands", async () => {
    const { io, out } = capture();
    expect(await run(["orders", "--help"], io, env())).toBe(0);
    expect(out.join("\n")).toContain("orders transitions");
  });

  it("needs a URL the first time it logs in", async () => {
    const { io, err } = capture();
    expect(await run(["login"], io, env())).toBe(2);
    expect(err.join("\n")).toContain("--url");
  });

  it("refuses a DELETE without a terminal unless --yes", async () => {
    const { io, err } = capture();
    expect(await run(["orders", "delete", "000000000000000000000001"], io, env())).toBe(2);
    expect(err.join("\n")).toContain("--yes");
  });

  it("checks the number of arguments against the endpoint", async () => {
    const { io, err } = capture();
    expect(await run(["orders", "get"], io, env())).toBe(2);
    expect(err.join("\n")).toContain("usage: graft orders get <orderId>");
  });

  it("rejects unknown flags", async () => {
    const { io } = capture();
    expect(await run(["whoami", "--nope"], io, env())).toBe(2);
  });

  it("is signed out by default", async () => {
    const { io } = capture();
    expect(await run(["whoami"], io, { ...env(), GRAFT_URL: "http://127.0.0.1:9" })).toBe(3);
  });
});

describe("read-only mode", () => {
  const env = () =>
    ({
      GRAFT_CONFIG_DIR: mkdtempSync(join(tmpdir(), "graft-cli-")),
      GRAFT_READONLY: "1",
      GRAFT_URL: "http://127.0.0.1:9",
    }) as unknown as NodeJS.ProcessEnv;

  it.each([["login"], ["logout"]])("refuses graft %s", async (cmd) => {
    const { io, err } = capture();
    expect(await run([cmd], io, env())).toBe(4);
    expect(err.join("\n")).toContain("GRAFT_READONLY");
  });

  it("refuses a create before asking anything", async () => {
    const { io } = capture();
    expect(await run(["orders", "create", "-d", "{}"], io, env())).toBe(4);
  });
});
