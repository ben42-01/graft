import { describe, expect, it } from "vitest";
import {
  commandName,
  customerEndpoints,
  deriveCommands,
  fillPath,
  loadCatalogue,
  matchCommand,
  type CatalogueEndpoint,
} from "./catalogue";

const ep = (
  method: string,
  path: string,
  extra: Partial<CatalogueEndpoint> = {},
): CatalogueEndpoint => ({
  id: `${method} ${path}`,
  method,
  path,
  group: path.split("/")[3],
  params: path
    .split("/")
    .filter((s) => s.startsWith(":"))
    .map((s) => s.slice(1)),
  auth: "session",
  summary: "",
  source: "",
  examples: [],
  ...extra,
});

const names = (endpoints: CatalogueEndpoint[]) =>
  Object.fromEntries(
    deriveCommands(endpoints).map((c) => [`${c.method} ${c.path}`, commandName(c)]),
  );

describe("deriveCommands", () => {
  it("names collections, items, nested resources, actions and singletons", () => {
    const got = names([
      ep("GET", "/api/v1/orders"),
      ep("POST", "/api/v1/orders"),
      ep("GET", "/api/v1/orders/:orderId"),
      ep("PATCH", "/api/v1/orders/:orderId"),
      ep("DELETE", "/api/v1/orders/:orderId"),
      ep("PUT", "/api/v1/orders/:orderId/payment-link"),
      ep("POST", "/api/v1/orders/:orderId/payment-link/send"),
      ep("POST", "/api/v1/orders/:orderId/transitions"),
      ep("GET", "/api/v1/entities/:entityId/records"),
      ep("GET", "/api/v1/entities/:entityId/records/:recordId"),
      ep("POST", "/api/v1/forms/:formId/media"),
      ep("POST", "/api/v1/forms/:formId/media/:mediaId"),
      ep("POST", "/api/v1/team/invites"),
      ep("DELETE", "/api/v1/team/invites/:inviteId"),
      ep("POST", "/api/v1/team/invites/accept"),
      ep("GET", "/api/v1/reports/sales"),
      ep("GET", "/api/v1/submissions"),
      ep("POST", "/api/v1/billing/checkout"),
    ]);
    expect(got).toEqual({
      "GET /api/v1/orders": "orders list",
      "POST /api/v1/orders": "orders create",
      "GET /api/v1/orders/:orderId": "orders get",
      "PATCH /api/v1/orders/:orderId": "orders update",
      "DELETE /api/v1/orders/:orderId": "orders delete",
      "PUT /api/v1/orders/:orderId/payment-link": "orders payment-link-set",
      "POST /api/v1/orders/:orderId/payment-link/send": "orders payment-link send",
      "POST /api/v1/orders/:orderId/transitions": "orders transitions",
      "GET /api/v1/entities/:entityId/records": "entities records list",
      "GET /api/v1/entities/:entityId/records/:recordId": "entities records get",
      "POST /api/v1/forms/:formId/media": "forms media create",
      "POST /api/v1/forms/:formId/media/:mediaId": "forms media confirm",
      "POST /api/v1/team/invites": "team invites create",
      "DELETE /api/v1/team/invites/:inviteId": "team invites delete",
      "POST /api/v1/team/invites/accept": "team invites accept",
      "GET /api/v1/reports/sales": "reports sales get",
      "GET /api/v1/submissions": "submissions list",
      "POST /api/v1/billing/checkout": "billing checkout",
    });
  });

  it("disambiguates by method rather than letting one endpoint shadow another", () => {
    const got = names([
      ep("PUT", "/api/v1/things/:id"),
      ep("POST", "/api/v1/things/:id/x"),
      ep("PATCH", "/api/v1/things/:id"),
    ]);
    expect(got["PUT /api/v1/things/:id"]).toBe("things set");
    expect(new Set(Object.values(got)).size).toBe(3);
  });

  it("gives every customer endpoint of the real catalogue its own command", () => {
    const endpoints = loadCatalogue();
    const commands = deriveCommands(endpoints);
    expect(commands).toHaveLength(endpoints.length);
    expect(new Set(commands.map(commandName)).size).toBe(commands.length);
  });

  it("never exposes platform-admin, auth, webhook or public endpoints", () => {
    const kept = customerEndpoints([
      ep("GET", "/api/v1/admin/tenants", { auth: "platform-admin", group: "admin" }),
      ep("POST", "/api/v1/auth/login", { auth: "public", group: "auth" }),
      ep("POST", "/api/v1/webhooks/stripe", { auth: "public", group: "webhooks" }),
      ep("GET", "/api/health", { auth: "public", group: "system" }),
      ep("GET", "/api/v1/orders"),
    ]);
    expect(kept.map((e) => e.path)).toEqual(["/api/v1/orders"]);
    expect(loadCatalogue().some((e) => e.auth === "platform-admin")).toBe(false);
  });
});

describe("matchCommand / fillPath", () => {
  const commands = deriveCommands([
    ep("GET", "/api/v1/entities"),
    ep("GET", "/api/v1/entities/:entityId/records"),
  ]);

  it("prefers the longest command and returns the leftover words as arguments", () => {
    const match = matchCommand(commands, ["entities", "records", "list", "abc"]);
    expect(commandName(match!.command)).toBe("entities records list");
    expect(match!.rest).toEqual(["abc"]);
  });

  it("returns null for words that are not a command", () => {
    expect(matchCommand(commands, ["orders", "list"])).toBeNull();
  });

  it("encodes arguments into the path", () => {
    expect(fillPath("/api/v1/entities/:entityId/records", ["a/b?c"])).toBe(
      "/api/v1/entities/a%2Fb%3Fc/records",
    );
  });
});
