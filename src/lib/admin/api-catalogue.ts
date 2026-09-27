/**
 * Typed access to the generated endpoint catalogue behind `/admin/sdk`.
 * The JSON is written by `npm run api:catalogue`
 * (scripts/generate-api-catalogue.ts) — never edit it by hand; the script's
 * test fails when it drifts from the routes.
 */
import raw from "./api-catalogue.json";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CatalogueExample = {
  name: string;
  file: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  body: string | null;
};

export type CatalogueEndpoint = {
  id: string;
  method: HttpMethod;
  path: string;
  group: string;
  params: string[];
  auth: "platform-admin" | "session" | "public";
  summary: string;
  source: string;
  examples: CatalogueExample[];
};

export const API_CATALOGUE: readonly CatalogueEndpoint[] = (
  raw as { endpoints: CatalogueEndpoint[] }
).endpoints;
