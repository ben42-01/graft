/**
 * The export walks paged endpoints, which is the part that can silently hand
 * a user an incomplete copy of their own data. These cover the cursor walk,
 * the honest `truncated` marker when a collection outruns the page cap, and
 * the fact that a failed read never throws away the rest of the export.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceExport } from "./account-export";

type Page = {
  data: unknown[];
  meta: { limit: number; hasMore: boolean; cursor: string | null };
};

const page = (data: unknown[], cursor: string | null = null): Page => ({
  data,
  meta: { limit: 100, hasMore: cursor !== null, cursor },
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes by path, ignoring the query string except for the cursor. */
function stubApi(handler: (path: string, cursor: string | null) => unknown) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const body = handler(url.pathname, url.searchParams.get("cursor"));
    if (body === undefined) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(jsonResponse(body));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("buildWorkspaceExport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the API's cursor until a collection is exhausted", async () => {
    stubApi((path, cursor) => {
      if (path === "/api/v1/me") return { data: { user: { id: "u1" } } };
      if (path === "/api/v1/entities") {
        return page([{ id: "e1", key: "customers", name: "Customers" }]);
      }
      if (path === "/api/v1/entities/e1/records") {
        return cursor === null
          ? page([{ id: "r1" }, { id: "r2" }], "cursor-2")
          : page([{ id: "r3" }]);
      }
      return page([]);
    });

    const result = await buildWorkspaceExport();

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].records).toEqual([{ id: "r1" }, { id: "r2" }, { id: "r3" }]);
    expect(result.truncated).toEqual([]);
    expect(result.account).toEqual({ user: { id: "u1" } });
  });

  it("marks the export truncated rather than pretending a capped collection is complete", async () => {
    stubApi((path) => {
      if (path === "/api/v1/me") return { data: null };
      if (path === "/api/v1/entities") return page([{ id: "e1", key: "big", name: "Big" }]);
      // Never stops offering a next cursor — the page cap has to break it.
      if (path === "/api/v1/entities/e1/records") return page([{ id: "r" }], "always-more");
      return page([]);
    });

    const result = await buildWorkspaceExport();

    expect(result.truncated).toContain("records:big");
    expect(result.entities[0].records.length).toBeGreaterThan(0);
  });

  it("still returns the rest of the export when one collection fails to read", async () => {
    stubApi((path) => {
      if (path === "/api/v1/me") return { data: { user: { id: "u1" } } };
      if (path === "/api/v1/entities") return page([]);
      if (path === "/api/v1/dashboards") return page([{ id: "d1" }]);
      return undefined; // /forms 404s
    });

    const result = await buildWorkspaceExport();

    expect(result.dashboards).toEqual([{ id: "d1" }]);
    expect(result.forms).toEqual([]);
    expect(result.account).toEqual({ user: { id: "u1" } });
  });

  it("reports progress so a slow export isn't a frozen button", async () => {
    stubApi((path) => (path === "/api/v1/me" ? { data: null } : page([])));
    const progress = vi.fn();

    await buildWorkspaceExport(progress);

    expect(progress).toHaveBeenCalled();
  });
});
