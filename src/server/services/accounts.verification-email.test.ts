/**
 * The verification email signup sends — the default `emitVerificationToken`.
 * Signup's own tests replace that seam, so the default is covered here: what
 * link it builds, and that a failed send never fails the signup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("@/server/mail/transport", () => ({ sendMail }));
vi.mock("@/env", () => ({ env: () => ({ APP_URL: "https://app.example.test" }) }));

import { sendVerificationEmail } from "./accounts";

const event = {
  userId: "00000000000000000000000c",
  email: "ada@example.test",
  token: "tok_ABC-123_xyzxyzxyzxyz",
  expiresAt: new Date("2026-10-05T12:00:00.000Z"),
};

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    sendMail.mockReset();
  });

  it("emails a link to /verify-email carrying the token", async () => {
    sendMail.mockResolvedValue(undefined);
    await sendVerificationEmail(event);

    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0][0];
    expect(message).toMatchObject({ kind: "auth.verification", to: "ada@example.test" });
    expect(message.text).toContain(
      "https://app.example.test/verify-email?token=tok_ABC-123_xyzxyzxyzxyz",
    );
    expect(message.text).toContain("24 hours");
  });

  it("swallows a failed send and logs it without the address or token", async () => {
    sendMail.mockRejectedValue(new Error("535 Bad credentials"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendVerificationEmail(event)).resolves.toBeUndefined();

    const printed = [...log.mock.calls, ...error.mock.calls]
      .map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("auth.verification.send_failed");
    expect(printed).not.toContain(event.email);
    expect(printed).not.toContain(event.token);
    log.mockRestore();
    error.mockRestore();
  });
});
