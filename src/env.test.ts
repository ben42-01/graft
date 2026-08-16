import { describe, expect, it } from "vitest";
import { schema } from "./env";

/**
 * GRAFT-02.1 AC1 (F3) — APP_ENV used to default to "dev". Since APP_ENV is what
 * decides whether `x-graft-*` headers may stand in for an authenticated identity
 * (src/server/context.ts), that default meant a production deploy which simply
 * forgot the variable trusted those headers outright. It is now required, so a
 * missing value fails loudly at startup instead of opening the door.
 */
describe("env schema", () => {
  const valid = {
    APP_ENV: "dev",
    NODE_ENV: "development",
    MONGODB_URI: "mongodb://localhost:27017/graft",
    REDIS_URL: "redis://localhost:6379",
  };

  it("accepts a fully specified environment", () => {
    expect(schema.parse(valid).APP_ENV).toBe("dev");
  });

  it("rejects a missing APP_ENV rather than defaulting it (AC1)", () => {
    const withoutAppEnv = { ...valid, APP_ENV: undefined };
    const parsed = schema.safeParse(withoutAppEnv);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path[0] === "APP_ENV")).toBe(true);
  });

  it("rejects an APP_ENV it does not recognise", () => {
    for (const APP_ENV of ["", "staging", "DEV", "prod"]) {
      expect(schema.safeParse({ ...valid, APP_ENV }).success, APP_ENV).toBe(false);
    }
  });
});
