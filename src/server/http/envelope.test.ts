import { describe, expect, it } from "vitest";
import {
  AppError,
  ERROR_CODES,
  STATUS_FOR_CODE,
  errorEnvelope,
  jsonError,
  jsonOk,
  successEnvelope,
} from "./envelope";

const RID = "req-envelope-test";

describe("successEnvelope", () => {
  it("wraps data and always carries the requestId in meta", () => {
    expect(successEnvelope({ id: "1" }, RID)).toEqual({
      data: { id: "1" },
      meta: { requestId: RID },
    });
  });

  it("merges caller meta without letting it drop the requestId", () => {
    const envelope = successEnvelope([1, 2], RID, { cursor: "abc", requestId: "spoofed" });
    expect(envelope.data).toEqual([1, 2]);
    expect(envelope.meta.cursor).toBe("abc");
    expect(envelope.meta.requestId).toBe(RID);
  });
});

describe("errorEnvelope", () => {
  it("renders an AppError with its code, message and details", () => {
    const error = new AppError("VALIDATION_FAILED", "Invalid request", {
      fields: { email: "Required" },
    });
    expect(errorEnvelope(error, RID)).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Invalid request",
        details: { fields: { email: "Required" } },
        requestId: RID,
      },
    });
  });

  // AC5 — nothing about the thrown error may reach the client.
  it("reduces an unknown error to INTERNAL with no leaked detail", () => {
    const leaky = new Error("connect ECONNREFUSED 10.0.0.7:27017 at /srv/graft/src/db.ts");
    const envelope = errorEnvelope(leaky, RID);
    expect(envelope.error.code).toBe("INTERNAL");
    expect(envelope.error.details).toBeUndefined();
    const serialised = JSON.stringify(envelope);
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("/srv/graft");
    expect(serialised).not.toContain("10.0.0.7");
  });

  it("hides the message of an AppError that is itself INTERNAL", () => {
    const envelope = errorEnvelope(new AppError("INTERNAL", "mongo replica set down"), RID);
    expect(envelope.error.message).not.toContain("replica");
    expect(envelope.error.details).toBeUndefined();
  });
});

describe("status mapping", () => {
  it("maps every declared error code to a status", () => {
    for (const code of ERROR_CODES) expect(STATUS_FOR_CODE[code]).toBeGreaterThanOrEqual(400);
  });

  it("uses the documented codes from docs/BACKEND.md §2", () => {
    expect([...ERROR_CODES]).toEqual([
      "VALIDATION_FAILED",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "EMAIL_NOT_VERIFIED",
      "NOT_FOUND",
      "QUOTA_EXCEEDED",
      "RATE_LIMITED",
      "CONFLICT",
      "INTERNAL",
    ]);
  });
});

describe("responses", () => {
  it("jsonOk returns 200 JSON with the request id header", async () => {
    const response = jsonOk({ ok: true }, RID);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toBe(RID);
    await expect(response.json()).resolves.toEqual({
      data: { ok: true },
      meta: { requestId: RID },
    });
  });

  it("jsonError uses the status for the code and keeps the request id", async () => {
    const response = jsonError(new AppError("NOT_FOUND", "No such record"), RID);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe(RID);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "No such record", requestId: RID },
    });
  });

  it("jsonError answers 500 for anything that is not an AppError", () => {
    expect(jsonError(new TypeError("boom"), RID).status).toBe(500);
    expect(jsonError("a thrown string", RID).status).toBe(500);
  });
});
