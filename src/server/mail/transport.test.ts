import { describe, expect, it, vi } from "vitest";
import { schema } from "@/env";
import { addressOf, logMailer, smtpConfigFrom, smtpMailer } from "./transport";

const message = {
  kind: "test",
  to: "ada@example.test",
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

const base = {
  APP_ENV: "dev",
  MONGODB_URI: "mongodb://localhost:27017/graft",
  REDIS_URL: "redis://localhost:6379",
};

describe("SMTP configuration from the environment", () => {
  it("is off unless host, user and password are all set", () => {
    expect(smtpConfigFrom(schema.parse(base))).toBeNull();
    expect(
      smtpConfigFrom(
        schema.parse({ ...base, SMTP_HOST: "smtp.gmail.com", SMTP_USER: "a@b.c" }),
      ),
    ).toBeNull();
  });

  it("strips the spaces Google shows in an App Password, and defaults port and sender", () => {
    const config = smtpConfigFrom(
      schema.parse({
        ...base,
        SMTP_HOST: "smtp.gmail.com",
        SMTP_USER: "owner@gmail.com",
        SMTP_PASS: "abcd efgh ijkl mnop",
      }),
    );
    expect(config).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      user: "owner@gmail.com",
      pass: "abcdefghijklmnop",
      from: "owner@gmail.com",
    });
  });
});

describe("smtpMailer", () => {
  const config = {
    host: "smtp.gmail.com",
    port: 465,
    user: "owner@gmail.com",
    pass: "x",
    from: "Graft <owner@gmail.com>",
  };

  it("sends from MAIL_FROM with both parts and the reply-to", async () => {
    const sendMail = vi.fn(async () => ({}) as never);
    await smtpMailer(config, { sendMail }).send({ ...message, replyTo: "shop@example.test" });
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: "Graft", address: "owner@gmail.com" },
      to: "ada@example.test",
      replyTo: "shop@example.test",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("swaps the display name but keeps the authenticated address", async () => {
    const sendMail = vi.fn(async () => ({}) as never);
    await smtpMailer(config, { sendMail }).send({
      ...message,
      fromName: "Lough Boats via Graft",
    });
    expect(sendMail.mock.calls[0]).toMatchObject([
      { from: { name: "Lough Boats via Graft", address: "owner@gmail.com" } },
    ]);
  });

  it("passes a refusal from the server up to the caller", async () => {
    const sendMail = vi.fn(async () => Promise.reject(new Error("535 Bad credentials")));
    await expect(smtpMailer(config, { sendMail }).send(message)).rejects.toThrow("535");
  });

  it("reads the address out of a display-name sender", () => {
    expect(addressOf("Graft <owner@gmail.com>")).toBe("owner@gmail.com");
    expect(addressOf(" owner@gmail.com ")).toBe("owner@gmail.com");
  });
});

describe("logMailer", () => {
  it("prints the whole message outside production, so a link can be followed by hand", async () => {
    const write = vi.fn();
    await logMailer("dev", write).send(message);
    const line = JSON.parse(write.mock.calls[0][0]);
    expect(line).toMatchObject({ msg: "mail.logged", to: "ada@example.test", text: "Hi" });
  });

  it("never prints the message in production", async () => {
    const write = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await logMailer("production", write).send(message);
    expect(write).not.toHaveBeenCalled();
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).not.toContain("ada@example.test");
    expect(printed).not.toContain('Hi"');
    log.mockRestore();
  });
});
