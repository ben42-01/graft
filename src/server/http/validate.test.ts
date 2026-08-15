import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "./envelope";
import { parse, parseBody, parseQuery } from "./validate";

const schema = z.object({
  email: z.string().email(),
  age: z.coerce.number().int().min(18),
});

const jsonRequest = (body: unknown) =>
  new Request("http://localhost/api/v1/things", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("parse", () => {
  it("returns the parsed value on success", () => {
    expect(parse(schema, { email: "a@b.test", age: "30" }, "body")).toEqual({
      email: "a@b.test",
      age: 30,
    });
  });

  // AC4 — details must name the offending fields.
  it("throws VALIDATION_FAILED naming every offending field", () => {
    let thrown: unknown;
    try {
      parse(schema, { email: "not-an-email", age: 12 }, "body");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.status).toBe(400);
    expect(error.details).toEqual({
      source: "body",
      fields: { email: expect.any(String), age: expect.any(String) },
    });
  });

  it("names nested fields by dotted path", () => {
    const nested = z.object({ profile: z.object({ handle: z.string() }) });
    try {
      parse(nested, { profile: {} }, "body");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).details).toMatchObject({
        fields: { "profile.handle": expect.any(String) },
      });
    }
  });
});

describe("parseBody", () => {
  it("parses a JSON body", async () => {
    await expect(
      parseBody(jsonRequest({ email: "a@b.test", age: 21 }), schema),
    ).resolves.toEqual({
      email: "a@b.test",
      age: 21,
    });
  });

  it("rejects a malformed body as VALIDATION_FAILED, not a 500", async () => {
    await expect(parseBody(jsonRequest("{ not json"), schema)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });
  });
});

describe("parseQuery", () => {
  const query = z.object({ limit: z.coerce.number().default(25), q: z.string().optional() });

  it("parses search params", () => {
    const request = new Request("http://localhost/api/v1/things?limit=10&q=ada");
    expect(parseQuery(request, query)).toEqual({ limit: 10, q: "ada" });
  });

  it("throws VALIDATION_FAILED for an unparseable param", () => {
    const request = new Request("http://localhost/api/v1/things?limit=abc");
    expect(() => parseQuery(request, query)).toThrow(AppError);
    try {
      parseQuery(request, query);
    } catch (error) {
      expect((error as AppError).details).toMatchObject({ source: "query" });
    }
  });
});
