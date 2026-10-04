/**
 * The one Graft email. Every message — verification, invite, payment link —
 * is this layout with different words in it, so they look like one product
 * and a change to the brand is a change in one file.
 *
 * Email HTML is its own dialect: tables for layout, every style inline, no
 * web fonts, no SVG (Gmail strips it). The wordmark is therefore text in the
 * brand green rather than the logo file. A plain-text part is always sent
 * alongside — some clients show only that, and spam filters dislike HTML-only
 * mail.
 *
 * Everything passed in is treated as text and escaped. Tenant-chosen strings
 * (a business name, a customer's name) end up here, so no field accepts HTML.
 */

export type EmailContent = {
  /** The inbox preview line, after the subject. Not shown in the body. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** One button. Its URL is also printed underneath, for clients that block buttons. */
  action?: { label: string; url: string };
  /** Small print under the button: an expiry, "not expecting this?". */
  footnote?: string;
  /** The last line of the body — the business, when the mail is from them. */
  signoff?: string;
};

const GREEN = "#16a34a";
const INK = "#0f172a";
const MUTED = "#64748b";
const PAGE = "#f4f6f5";
const BORDER = "#e2e8f0";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) reaches an href — anything else would be a link we never meant to send. */
const safeUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to put a ${parsed.protocol} link in an email`);
  }
  return parsed.toString();
};

const paragraph = (text: string) =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">${escapeHtml(text)}</p>`;

function button(label: string, url: string): string {
  const href = escapeHtml(url);
  return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
            <tr>
              <td style="border-radius:8px;background:${GREEN};">
                <a href="${href}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 16px;font-size:12px;line-height:18px;color:${MUTED};">If the button doesn't work, copy this link into your browser:<br><a href="${href}" style="color:${GREEN};word-break:break-all;">${href}</a></p>`;
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const action = content.action
    ? { label: content.action.label, url: safeUrl(content.action.url) }
    : undefined;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(content.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
    <tr>
      <td align="center" style="padding:32px 16px;font-family:${FONT};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <tr>
            <td style="padding:0 4px 16px;font-family:${FONT};font-size:22px;font-weight:700;letter-spacing:-0.5px;color:${GREEN};">graft<span style="color:${INK};">.</span></td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid ${BORDER};border-top:4px solid ${GREEN};border-radius:12px;padding:32px 28px;font-family:${FONT};">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${INK};">${escapeHtml(content.heading)}</h1>
          ${content.paragraphs.map(paragraph).join("\n          ")}
          ${action ? button(action.label, action.url) : ""}
          ${content.signoff ? paragraph(content.signoff) : ""}
          ${content.footnote ? `<p style="margin:16px 0 0;padding-top:16px;border-top:1px solid ${BORDER};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(content.footnote)}</p>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">Sent with Graft — graft together the business system that fits you.</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    content.heading,
    "",
    ...content.paragraphs.flatMap((line) => [line, ""]),
    ...(action ? [`${action.label}: ${action.url}`, ""] : []),
    ...(content.signoff ? [content.signoff, ""] : []),
    ...(content.footnote ? ["—", content.footnote, ""] : []),
    "Sent with Graft",
  ].join("\n");

  return { html, text };
}
