/**
 * How a message leaves the building. One interface, two implementations:
 *
 *   - **SMTP** when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` are all set. Today
 *     that is the owner's Gmail with an App Password; a paid provider later is
 *     a different host and credentials, not a code change.
 *   - **Log** otherwise. Outside production the whole message is printed to
 *     stdout, so a developer can follow a verification or invite link without a
 *     mailbox, and tests, CI and the QA stack never send anything. In
 *     production an unconfigured mailer logs only that it dropped a message.
 *
 * The log branch writes straight to stdout rather than through `createLogger`:
 * `redact()` strips `email`/`token`-shaped values in every environment, and the
 * printed link *is* a credential. It is the same deliberate, dev-only exception
 * the verification log line used to be (src/server/services/accounts.ts).
 *
 * Templates never import this file — they return `{ html, text }` and the
 * caller hands that to `sendMail`.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { env, type Env } from "@/env";
import { createLogger } from "@/server/log";

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Where replies go — the business, when Graft writes on its behalf. */
  replyTo?: string;
  /** Replaces the display name in MAIL_FROM, e.g. "Acme via Graft". The address stays. */
  fromName?: string;
  /** What kind of email this is, for logs. Never who it is to. */
  kind: string;
};

export type Mailer = {
  readonly transport: "smtp" | "log";
  send(message: MailMessage): Promise<void>;
};

type SmtpConfig = { host: string; port: number; user: string; pass: string; from: string };

/** `Graft <a@b.c>` → `a@b.c`; a bare address is returned as it is. */
export const addressOf = (from: string): string =>
  from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim();

/** `Graft <a@b.c>` → `Graft`; null when there is no display name. */
const nameOf = (from: string): string | null => {
  const name = from
    .replace(/<[^>]*>/, "")
    .trim()
    .replace(/^"|"$/g, "");
  return name && name !== from.trim() ? name : null;
};

export function smtpConfigFrom(
  config: Pick<Env, "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASS" | "MAIL_FROM">,
): SmtpConfig | null {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = config;
  if (!host || !user || !pass) return null;
  return { host, port: config.SMTP_PORT, user, pass, from: config.MAIL_FROM ?? user };
}

export function smtpMailer(
  config: SmtpConfig,
  transporter: Pick<Transporter, "sendMail"> = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 is TLS from the first byte; 587 upgrades with STARTTLS.
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  }),
): Mailer {
  const address = addressOf(config.from);
  const defaultName = nameOf(config.from);
  return {
    transport: "smtp",
    async send(message) {
      const name = message.fromName ?? defaultName;
      await transporter.sendMail({
        from: name ? { name, address } : address,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    },
  };
}

export function logMailer(
  appEnv: Env["APP_ENV"],
  write: (line: string) => void = (line) => console.log(line),
): Mailer {
  return {
    transport: "log",
    async send(message) {
      if (appEnv === "production") {
        createLogger({ requestId: "mail" }).warn("mail.not_configured", { kind: message.kind });
        return;
      }
      write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          msg: "mail.logged",
          requestId: "mail",
          kind: message.kind,
          to: message.to,
          replyTo: message.replyTo ?? null,
          subject: message.subject,
          text: message.text,
        }),
      );
    },
  };
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;
  const config = env();
  const smtp = smtpConfigFrom(config);
  cached = smtp ? smtpMailer(smtp) : logMailer(config.APP_ENV);
  return cached;
}

/** The one call the rest of the app makes. Throws when the SMTP server refuses. */
export async function sendMail(message: MailMessage): Promise<void> {
  const mailer = getMailer();
  await mailer.send(message);
  createLogger({ requestId: "mail" }).info("mail.sent", {
    kind: message.kind,
    transport: mailer.transport,
  });
}
