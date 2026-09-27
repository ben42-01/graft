/**
 * The SDK screen's endpoint catalogue. The first test is the one that matters
 * day to day: it rebuilds the catalogue from the routes and Bruno files and
 * fails when the committed copy has drifted — the fix is `npm run api:catalogue`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authOf,
  buildCatalogue,
  CATALOGUE_FILE,
  exportedMethods,
  matchPath,
  parseBruno,
  routePath,
  serialise,
  summaryOf,
} from "./generate-api-catalogue";

const root = process.cwd();

describe("api catalogue", () => {
  it("the committed catalogue matches the routes on disk (run `npm run api:catalogue`)", () => {
    const committed = readFileSync(join(root, CATALOGUE_FILE), "utf8");
    expect(committed).toBe(serialise(buildCatalogue(root)));
  });

  it("lists every admin route and never the unrouted catch-all", () => {
    const ids = buildCatalogue(root).endpoints.map((e) => e.id);
    expect(ids).toContain("GET /api/v1/admin/overview");
    expect(ids).toContain("POST /api/v1/admin/tenants/:tenantId/tier");
    expect(ids.some((id) => id.includes("*"))).toBe(false);
  });

  it("derives paths from folders, dropping route groups and naming params", () => {
    const api = "/r/src/app/api";
    expect(routePath(api, `${api}/v1/entities/[entityId]/route.ts`)).toBe(
      "/api/v1/entities/:entityId",
    );
    expect(routePath(api, `${api}/(grp)/v1/x/route.ts`)).toBe("/api/v1/x");
  });

  it("reads exported methods, summary and auth level from source", () => {
    const source = `/**\n * GET|POST /api/v1/things — list and create things.\n *\n * More.\n */\nexport const GET = route(async () => { await context(); });\nexport async function POST() {}`;
    expect(exportedMethods(source)).toEqual(["GET", "POST"]);
    expect(summaryOf(source)).toBe("list and create things.");
    expect(authOf(source)).toBe("session");
    expect(authOf("// mentions context() only")).toBe("public");
    expect(authOf("await assertPlatformAdmin(ctx)")).toBe("platform-admin");
  });

  it("parses a Bruno request's method, path, query and JSON body", () => {
    const bru = [
      "meta {",
      "  name: Creates a thing",
      "}",
      "",
      "post {",
      "  url: {{baseUrl}}/api/v1/things/abc?x=1&y=two",
      "}",
      "",
      "body:json {",
      "  {",
      '    "a": 1',
      "  }",
      "}",
    ].join("\n");
    expect(parseBruno(bru)).toEqual({
      name: "Creates a thing",
      method: "POST",
      path: "/api/v1/things/abc",
      query: { x: "1", y: "two" },
      body: '{\n  "a": 1\n}',
    });
  });

  it("matches concrete paths onto patterns", () => {
    expect(matchPath("/api/v1/things/:id", "/api/v1/things/abc")).toEqual({ id: "abc" });
    expect(matchPath("/api/v1/things/:id", "/api/v1/things")).toBeNull();
    expect(matchPath("/api/v1/things", "/api/v1/other")).toBeNull();
  });
});
