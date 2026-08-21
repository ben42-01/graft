/**
 * Renders `PRIVACY_SECTIONS` (@/lib/legal/privacy). Shared by the in-app
 * page (`/account/privacy`) and the public one (`/privacy`) so the two can
 * never show different text — the whole reason the statement is data.
 *
 * Not a client component: it is static text with no interactivity, so both
 * pages can render it on the server.
 */
import {
  EFFECTIVE_DATE,
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_SECTIONS,
  VERSION,
} from "@/lib/legal/privacy";

export function PrivacyStatement() {
  return (
    <article className="flex flex-col gap-8">
      {PRIVACY_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="scroll-mt-20">
          <h2 className="text-lg font-semibold tracking-tight">{section.heading}</h2>
          <div className="mt-2 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
            {section.blocks.map((block, index) =>
              block.kind === "p" ? (
                <p key={index}>{block.text}</p>
              ) : (
                <ul key={index} className="flex list-disc flex-col gap-1.5 pl-5">
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ),
            )}
          </div>
        </section>
      ))}
    </article>
  );
}

/** The version/date/contact line every surface shows above the statement. */
export function PrivacyMeta() {
  return (
    <p className="text-sm text-muted-foreground">
      Version {VERSION} · Effective {EFFECTIVE_DATE} ·{" "}
      <a
        href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
        className="underline underline-offset-4 hover:text-foreground"
      >
        {PRIVACY_CONTACT_EMAIL}
      </a>
    </p>
  );
}
